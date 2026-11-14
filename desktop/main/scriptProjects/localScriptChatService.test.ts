import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}));

import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { ScriptChatMessageRepository } from "../database/scriptChatMessageRepository";

import { LocalScriptChatService } from "./localScriptChatService";

const TOOLS = [
  {
    function_declarations: [
      {
        name: "reply",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"]
        }
      }
    ]
  }
];

const REPLY = JSON.stringify({
  function_call: { name: "reply", args: { message: "Here is an idea." } }
});

const temporaryDirectories: string[] = [];
const managers: DatabaseManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setup = async () => {
  const libraryRoot = await mkdtemp(path.join(tmpdir(), "mago-chat-"));
  temporaryDirectories.push(libraryRoot);
  const manager = new DatabaseManager();
  managers.push(manager);
  await manager.open(libraryRoot);
  const project = await new ProjectRepository(
    manager,
    async () => libraryRoot
  ).create({
    name: "Script",
    description: "",
    settings: { type: "script_to_shots" }
  });
  const messages = new ScriptChatMessageRepository(manager);
  return { projectId: project.id, messages, manager, libraryRoot };
};

/** A model run the test resolves by hand. */
const deferredRuns = () => {
  const prompts: string[] = [];
  const resolvers: Array<(answer: string) => void> = [];
  const rejecters: Array<(error: Error) => void> = [];
  const run = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      prompts.push(prompt);
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  return { run, prompts, resolvers, rejecters };
};

const waitFor = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
};

describe("LocalScriptChatService", () => {
  test("stores cloud replies and model provenance in the local transcript", async () => {
    const { projectId, messages } = await setup();
    const chat = new LocalScriptChatService(
      messages,
      async () => {},
      async () => ({
        content: REPLY,
        model: "cloud"
      })
    );
    await chat.post({ projectId, message: "An idea", tools: TOOLS });
    await waitFor(async () => !(await chat.list(projectId)).pending);
    const rows = await messages.listRecent(projectId, 20);
    expect(rows.at(-1)?.data.model).toBe("cloud");
    expect(rows.at(-1)?.data.function_call).toEqual({
      name: "reply",
      args: { message: "Here is an idea." }
    });
  });

  test("accepts a turn as PENDING, then stores the model's call", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    const chat = new LocalScriptChatService(messages, async () => {}, runs.run);

    const accepted = await chat.post({
      projectId,
      message: "  give me an idea  ",
      systemPrompt: "You are the script agent.",
      tools: TOOLS
    });
    expect(accepted.status).toBe("PENDING");

    const pending = await chat.list(projectId);
    expect(pending.pending).toBe(true);
    expect(pending.messages.map((row) => [row.role, row.status])).toEqual([
      ["user", "COMPLETED"],
      ["assistant", "PENDING"]
    ]);
    expect(pending.messages[0]!.content).toBe("give me an idea");
    expect(runs.prompts[0]).toContain("You are the script agent.");

    runs.resolvers[0]!(REPLY);
    await waitFor(async () => !(await chat.list(projectId)).pending);

    const [, reply] = (await chat.list(projectId)).messages;
    expect(reply).toEqual(
      expect.objectContaining({
        id: accepted.message_id,
        status: "COMPLETED",
        content: REPLY,
        function_call: { name: "reply", args: { message: "Here is an idea." } }
      })
    );
  });

  test("returns the reply already in flight instead of starting a second", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    const chat = new LocalScriptChatService(messages, async () => {}, runs.run);

    const first = await chat.post({ projectId, message: "one", tools: TOOLS });
    const second = await chat.post({ projectId, message: "two", tools: TOOLS });

    expect(second.message_id).toBe(first.message_id);
    expect(runs.prompts).toHaveLength(1);
    expect((await chat.list(projectId)).messages).toHaveLength(2);
  });

  test("repairs an unusable answer once, then fails the turn with the reason", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    const chat = new LocalScriptChatService(messages, async () => {}, runs.run);

    await chat.post({ projectId, message: "hi", tools: TOOLS });
    runs.resolvers[0]!("Sure!");
    await waitFor(async () => runs.prompts.length === 2);
    expect(runs.prompts[1]).toContain("RETRY REQUIREMENT");
    runs.resolvers[1]!('{"function_call": {"name": "reply", "args": {}}}');

    await waitFor(async () => !(await chat.list(projectId)).pending);
    const [, reply] = (await chat.list(projectId)).messages;
    expect(reply).toEqual(
      expect.objectContaining({
        status: "FAILED",
        content: "",
        error: "reply is missing message"
      })
    );
  });

  test("replays completed turns and reuses the stored system prompt", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    const chat = new LocalScriptChatService(messages, async () => {}, runs.run);

    await chat.post({
      projectId,
      message: "first",
      systemPrompt: "Stored prompt.",
      tools: TOOLS
    });
    runs.resolvers[0]!(REPLY);
    await waitFor(async () => !(await chat.list(projectId)).pending);

    await chat.post({ projectId, message: "second", tools: TOOLS });
    expect(runs.prompts[1]).toContain("SYSTEM INSTRUCTIONS:\nStored prompt.");
    expect(runs.prompts[1]).toContain("USER: first");
    expect(runs.prompts[1]).toContain(`ASSISTANT: ${REPLY}`);
  });

  test("fails a reply an earlier session left PENDING, so the chat stays answerable", async () => {
    const { projectId, messages } = await setup();
    await messages.insertTurn({ projectId, message: "lost", replyData: {} });

    const runs = deferredRuns();
    const chat = new LocalScriptChatService(messages, async () => {}, runs.run);
    const history = await chat.list(projectId);

    expect(history.pending).toBe(false);
    expect(history.messages[1]).toEqual(
      expect.objectContaining({ status: "FAILED" })
    );
    await chat.post({ projectId, message: "again", tools: TOOLS });
    expect(runs.prompts).toHaveLength(1);
  });

  test("refuses an empty message and a project that is not local", async () => {
    const { projectId, messages } = await setup();
    const chat = new LocalScriptChatService(
      messages,
      async (id) => {
        if (id !== projectId) throw new Error("Local script project not found");
      },
      vi.fn()
    );
    await expect(chat.post({ projectId, message: "   " })).rejects.toThrow(
      "message is required"
    );
    await expect(chat.list("cloud-project")).rejects.toThrow(
      "Local script project not found"
    );
  });

  test("does not retry a transport failure as a malformed response", async () => {
    const { projectId, messages } = await setup();
    const run = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const chat = new LocalScriptChatService(messages, async () => {}, run);
    await chat.post({ projectId, message: "hi", tools: TOOLS });
    await waitFor(async () => !(await chat.list(projectId)).pending);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await chat.list(projectId)).messages[1]?.error).toBe(
      "provider unavailable"
    );
  });

  test("shutdown aborts the completion, suppresses repair and preserves orphan recovery", async () => {
    const { projectId, messages } = await setup();
    let finish!: (value: string) => void;
    let signal!: AbortSignal;
    const run = vi.fn((_prompt: string, caller?: AbortSignal) => {
      signal = caller!;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const chat = new LocalScriptChatService(messages, async () => {}, run);
    const accepted = await chat.post({
      projectId,
      message: "hi",
      tools: TOOLS
    });
    chat.stop();
    expect(signal.aborted).toBe(true);
    finish("malformed");
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await messages.listPending(projectId))[0]?.id).toBe(
      accepted.message_id
    );
    const restarted = new LocalScriptChatService(
      messages,
      async () => {},
      vi.fn()
    );
    expect((await restarted.list(projectId)).pending).toBe(false);
    await expect(
      chat.post({ projectId, message: "too late" })
    ).rejects.toThrow();
  });

  test("explicit cancellation aborts only its turn and a stale ID cannot cancel the next one", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    const signals: AbortSignal[] = [];
    const chat = new LocalScriptChatService(
      messages,
      async () => {},
      (prompt, signal) => {
        signals.push(signal!);
        return runs.run(prompt);
      }
    );
    const first = await chat.post({
      projectId,
      message: "first",
      tools: TOOLS
    });
    expect(await chat.cancel("another-project", first.message_id)).toBe(false);
    expect(signals[0]!.aborted).toBe(false);
    expect(await chat.cancel(projectId, first.message_id)).toBe(true);
    expect(signals[0]!.aborted).toBe(true);
    expect((await chat.list(projectId)).messages.at(-1)).toMatchObject({
      status: "FAILED",
      error: "the reply was cancelled"
    });
    const next = await chat.post({ projectId, message: "next", tools: TOOLS });
    expect(await chat.cancel(projectId, first.message_id)).toBe(false);
    expect(signals[1]!.aborted).toBe(false);
    runs.resolvers[0]!(REPLY);
    await Promise.resolve();
    await Promise.resolve();
    expect((await chat.list(projectId)).messages.at(-1)).toMatchObject({
      id: next.message_id,
      status: "PENDING"
    });
    runs.resolvers[1]!(REPLY);
    await waitFor(async () => !(await chat.list(projectId)).pending);
    expect((await chat.list(projectId)).messages[1]?.status).toBe("FAILED");
  });

  test.each(["malformed", REPLY])(
    "ignores a late cancelled response (%s) without repair or persistence",
    async (response) => {
      const { projectId, messages } = await setup();
      const runs = deferredRuns();
      const chat = new LocalScriptChatService(
        messages,
        async () => {},
        runs.run
      );
      await chat.post({ projectId, message: "first", tools: TOOLS });
      expect(await chat.cancel(projectId)).toBe(true);
      const write = vi.spyOn(messages, "finishReply");
      runs.resolvers[0]!(response);
      await chat.list(projectId);
      expect(runs.prompts).toHaveLength(1);
      expect(write).not.toHaveBeenCalled();
      expect((await chat.list(projectId)).pending).toBe(false);
    }
  );

  test("cancels an active malformed-response repair", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    let signal!: AbortSignal;
    const chat = new LocalScriptChatService(
      messages,
      async () => {},
      (prompt, caller) => {
        signal = caller!;
        return runs.run(prompt);
      }
    );
    await chat.post({ projectId, message: "first", tools: TOOLS });
    runs.resolvers[0]!("malformed");
    await waitFor(async () => runs.prompts.length === 2);
    await chat.cancel(projectId);
    expect(signal.aborted).toBe(true);
    runs.resolvers[1]!(REPLY);
    expect((await chat.list(projectId)).messages.at(-1)?.status).toBe("FAILED");
  });

  test("serializes a project cancellation behind a starting turn", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    const chat = new LocalScriptChatService(messages, async () => {}, runs.run);
    const posting = chat.post({ projectId, message: "queued", tools: TOOLS });
    const cancelling = chat.cancel(projectId);
    const listing = chat.list(projectId);
    await posting;
    expect(await cancelling).toBe(true);
    expect((await listing).pending).toBe(false);
    runs.resolvers[0]!(REPLY);
  });

  test("suspension drains row operations, refuses queued work and does not wait for the provider", async () => {
    const { projectId, messages } = await setup();
    const runs = deferredRuns();
    const chat = new LocalScriptChatService(messages, async () => {}, runs.run);
    const accepted = await chat.post({
      projectId,
      message: "old library",
      tools: TOOLS
    });
    let release!: () => void;
    const originalRead = messages.listRecent.bind(messages);
    const read = vi
      .spyOn(messages, "listRecent")
      .mockImplementationOnce(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return originalRead(...args);
      });
    const listing = chat.list(projectId);
    const rejected = expect(listing).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const queued = chat.post({ projectId, message: "must not start" });
    const queuedRejection = expect(queued).rejects.toThrow();
    let drained = false;
    const suspended = chat.suspend().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([suspended, rejected, queuedRejection]);
    read.mockRestore();
    expect((await messages.listPending(projectId))[0]?.id).toBe(
      accepted.message_id
    );
    const write = vi.spyOn(messages, "finishReply");
    chat.reset();
    runs.resolvers[0]!("malformed");
    await Promise.resolve();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(runs.prompts).toHaveLength(1);
    expect((await chat.list(projectId)).pending).toBe(false);
    await chat.post({ projectId, message: "new library", tools: TOOLS });
    expect(runs.prompts).toHaveLength(2);
    runs.resolvers[1]!(REPLY);
    await waitFor(async () => !(await chat.list(projectId)).pending);
  });

  test("cancels a persisted orphan without running inference", async () => {
    const { projectId, messages } = await setup();
    const { answer } = await messages.insertTurn({
      projectId,
      message: "orphan",
      replyData: {}
    });
    const run = vi.fn();
    const chat = new LocalScriptChatService(messages, async () => {}, run);
    expect(await chat.cancel(projectId, answer.id)).toBe(true);
    expect((await chat.list(projectId)).messages.at(-1)).toMatchObject({
      status: "FAILED",
      error: "the reply was cancelled"
    });
    expect(run).not.toHaveBeenCalled();
  });
});

test("late chat completion cannot write to a replacement library with identical project/message IDs", async () => {
  const { projectId, messages, manager, libraryRoot } = await setup();
  const runs = deferredRuns();
  const chat = new LocalScriptChatService(messages, async () => {}, runs.run);
  const first = await chat.post({
    projectId,
    message: "old library",
    tools: TOOLS
  });
  await chat.suspend();
  manager.close();
  const replacement = await mkdtemp(
    path.join(tmpdir(), "mago-chat-replacement-")
  );
  temporaryDirectories.push(replacement);
  await copyFile(
    path.join(libraryRoot, "mago.sqlite3"),
    path.join(replacement, "mago.sqlite3")
  );
  await manager.open(replacement);
  chat.reset();
  const write = vi.spyOn(messages, "finishReply");
  runs.resolvers[0]!(REPLY);
  await Promise.resolve();
  await Promise.resolve();
  expect(write).not.toHaveBeenCalled();
  expect((await messages.listPending(projectId))[0]?.id).toBe(first.message_id);
  // The new session, not the old provider, owns orphan recovery.
  expect((await chat.list(projectId)).pending).toBe(false);
  const next = await chat.post({
    projectId,
    message: "new library",
    tools: TOOLS
  });
  runs.resolvers[1]!(REPLY);
  await waitFor(async () => !(await chat.list(projectId)).pending);
  expect((await chat.list(projectId)).messages.at(-1)).toMatchObject({
    id: next.message_id,
    status: "COMPLETED"
  });
});
