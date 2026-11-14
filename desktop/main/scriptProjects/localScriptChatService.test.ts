import { mkdtemp, rm } from "node:fs/promises";
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
  return { projectId: project.id, messages };
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
});
