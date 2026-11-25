import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dialog: vi.fn(),
  spawn: vi.fn()
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.dialog },
  shell: {}
}));
vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.spawn
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS } from "../../shared/contracts";
import type { FetchCloudStorage } from "../cloudStorage/fetchCloudStorageObject";
import { registerLibraryHandlers } from "../ipc/registerLibraryHandlers";
import { registerProjectHandlers } from "../ipc/registerProjectHandlers";
import { registerScriptProjectHandlers } from "../ipc/registerScriptProjectHandlers";
import type { LibrarySettings } from "../librarySettings";
import { ProfileIoDrain } from "../providers/profileIoDrain";
import { ProfileLifetime } from "../providers/profileLifetime";
import type { LocalScriptChatService } from "../scriptProjects/localScriptChatService";
import { LocalScriptProjectService } from "../scriptProjects/localScriptProjectService";

import { CloudProjectMirrorRepository } from "./cloudProjectMirrorRepository";
import { DatabaseManager } from "./databaseManager";
import { ProjectRepository } from "./projectRepository";
import {
  assets,
  cloudLinks,
  projects,
  scriptProjectMedia,
  scriptProjectSnapshots
} from "./schema";
import { ScriptProjectSnapshotRepository } from "./scriptProjectSnapshotRepository";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const directories: string[] = [];
const managers: DatabaseManager[] = [];
const config = resolveCloudConfig();
const url = `https://${config.cloudStorageHosts[0]}/same.mp4`;
const event = {
  senderFrame: { url: `https://${config.rendererHost}/` },
  sender: { isDestroyed: () => false, send: vi.fn() }
};
const invoke = async (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!(event, ...args);
const observe = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );
const mirrorInput = {
  project: { id: "project", name: "old mutation" },
  includeContent: false
};
const cacheInput = {
  projectId: "project",
  assetId: "asset",
  isImage: false,
  sourceUrl: url
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
});

const fixture = async () => {
  const roots = await Promise.all(
    [0, 1].map(() => mkdtemp(path.join(tmpdir(), "mago-main-mirror-owner-")))
  );
  directories.push(...roots);
  const manager = new DatabaseManager();
  managers.push(manager);
  for (const [index, root] of roots.entries()) {
    await manager.open(root);
    await manager
      .get()
      .insert(projects)
      .values({
        id: "project",
        name: `library ${index}`,
        settingsJson: JSON.stringify({ origin: "cloud" })
      });
    await manager
      .get()
      .insert(assets)
      .values({
        id: "asset",
        name: `asset ${index}`,
        type: "video",
        origin: "uploaded",
        sourcePath: "",
        status: "pending"
      });
    await manager
      .get()
      .insert(scriptProjectSnapshots)
      .values({
        projectId: "project",
        stateJson: JSON.stringify({ label: `library ${index}`, url })
      });
  }
  let root = roots[0]!;
  await manager.open(root);
  const getRoot = vi.fn(async () => root);
  const mode = vi.fn(async () => "cloud");
  const setRoot = vi.fn(async (next: string) => {
    root = next;
  });
  const settings = {
    getLibraryRoot: getRoot,
    getAppMode: mode,
    assertWritable: vi.fn(async () => {}),
    setLibraryRoot: setRoot
  } as unknown as LibrarySettings;
  const fetchFromCloudStorage = vi.fn<FetchCloudStorage>(
    async () => new Response("video")
  );
  const access = {
    allowedHosts: config.cloudStorageHosts,
    fetchFromCloudStorage
  };
  const account = new ProfileLifetime();
  const profileIo = new ProfileIoDrain();
  const retireAccount = async () => {
    account.suspend();
    await profileIo.drainRetired();
    account.resume();
  };
  const mirrors = new CloudProjectMirrorRepository(
    manager,
    getRoot,
    access,
    profileIo
  );
  const snapshots = new ScriptProjectSnapshotRepository(
    manager,
    getRoot,
    access
  );
  const repository = new ProjectRepository(manager, getRoot);
  const service = new LocalScriptProjectService(
    repository,
    snapshots,
    async () => "http://unused.invalid"
  );
  registerProjectHandlers(
    repository,
    mirrors,
    manager,
    settings,
    undefined,
    undefined,
    undefined,
    () => account.capture(),
    undefined,
    profileIo
  );
  registerScriptProjectHandlers({
    service,
    chat: {} as LocalScriptChatService,
    databaseManager: manager,
    settings
  });
  const suspend = () =>
    Promise.all([
      mirrors.libraryWork.suspend(),
      snapshots.libraryWork.suspend(),
      service.suspendPlans()
    ]);
  const reset = () => {
    mirrors.libraryWork.reset();
    snapshots.libraryWork.reset();
    service.resetPlans();
  };
  registerLibraryHandlers({
    settings,
    databaseManager: manager,
    repository,
    beforeLibraryChange: async () => {
      await suspend();
    },
    afterLibraryChange: reset
  });
  mocks.dialog.mockResolvedValue({ canceled: false, filePaths: [roots[1]] });
  const choose = () => invoke(IPC_CHANNELS.libraryChoose);
  const project = async () =>
    (
      await manager
        .get()
        .select()
        .from(projects)
        .where(eq(projects.id, "project"))
    )[0]!;
  const asset = async () =>
    (
      await manager.get().select().from(assets).where(eq(assets.id, "asset"))
    )[0]!;
  const cache = () => invoke(IPC_CHANNELS.projectsCacheCloudAsset, cacheInput);
  const scriptCache = () =>
    invoke(IPC_CHANNELS.scriptProjectsCacheMedia, "project", url);
  return {
    roots,
    manager,
    getRoot,
    mode,
    setRoot,
    mirrors,
    snapshots,
    service,
    fetchFromCloudStorage,
    suspend,
    reset,
    choose,
    retireAccount,
    project,
    asset,
    cache,
    scriptCache
  };
};

it.each([
  IPC_CHANNELS.projectsMirrorCloud,
  IPC_CHANNELS.projectsCacheCloudAsset
])(
  "captures production %s origin before account waits without draining policy",
  async (channel) => {
    const f = await fixture();
    const account = deferred<string>();
    f.mode.mockImplementationOnce(() => account.promise);
    const stale = observe(
      invoke(
        channel,
        channel === IPC_CHANNELS.projectsMirrorCloud ? mirrorInput : cacheInput
      )
    );
    await vi.waitFor(() => expect(f.mode).toHaveBeenCalledOnce());
    await f.choose();
    account.resolve("cloud");
    expect(await stale).toBeInstanceOf(Error);
    expect((await f.project()).name).toBe("library 1");
    expect((await f.asset()).status).toBe("pending");
    expect(f.fetchFromCloudStorage).not.toHaveBeenCalled();
  }
);

it("drains issued root lookup and refuses a stale DB open", async () => {
  const f = await fixture();
  f.manager.close();
  const root = deferred<string>();
  f.getRoot.mockImplementationOnce(() => root.promise);
  const open = vi.spyOn(f.manager, "open");
  const stale = observe(invoke(IPC_CHANNELS.projectsMirrorCloud, mirrorInput));
  await vi.waitFor(() => expect(f.getRoot).toHaveBeenCalledOnce());
  let changed = false;
  const choosing = f.choose().then(() => {
    changed = true;
  });
  await vi.waitFor(() =>
    expect(f.mirrors.libraryWork.signal.aborted).toBe(true)
  );
  await flush();
  expect(changed).toBe(false);
  root.resolve(f.roots[0]!);
  await choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect(open.mock.calls).toEqual([[f.roots[1]]]);
});

it("drains a complete issued DB open before opening the replacement", async () => {
  const f = await fixture();
  f.manager.close();
  const gate = deferred();
  const open = f.manager.open.bind(f.manager);
  const opens: string[] = [];
  vi.spyOn(f.manager, "open").mockImplementation(async (root) => {
    opens.push(root);
    if (root === f.roots[0]) await gate.promise;
    await open(root);
  });
  const stale = observe(invoke(IPC_CHANNELS.projectsMirrorCloud, mirrorInput));
  await vi.waitFor(() => expect(opens).toEqual([f.roots[0]]));
  const choosing = f.choose();
  await vi.waitFor(() =>
    expect(f.mirrors.libraryWork.signal.aborted).toBe(true)
  );
  expect(opens).toEqual([f.roots[0]]);
  gate.resolve();
  await choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect(opens).toEqual(f.roots);
  expect((await f.project()).name).toBe("library 1");
});

it.each(["library", "account"])(
  "drains the whole metadata transaction on %s retirement, without admitting content",
  async (scope) => {
    const f = await fixture();
    const gate = deferred();
    const writing = deferred();
    const transaction = f.manager.transaction.bind(f.manager);
    const inserts: unknown[] = [];
    const begin = vi
      .spyOn(f.manager, "transaction")
      .mockImplementation((write, signal) =>
        transaction((db) => {
          const held = new Proxy(db, {
            get(target, key, receiver) {
              if (key !== "insert") return Reflect.get(target, key, receiver);
              return (...args: Parameters<typeof db.insert>) => {
                inserts.push(args[0]);
                const query = db.insert(...args);
                if (args[0] !== projects) return query;
                const values = query.values.bind(query);
                return {
                  values: (...input: Parameters<typeof values>) => {
                    const q = values(...input);
                    return {
                      onConflictDoUpdate: async (
                        ...conflict: Parameters<typeof q.onConflictDoUpdate>
                      ) => {
                        await q.onConflictDoUpdate(...conflict);
                        writing.resolve();
                        await gate.promise;
                      }
                    };
                  }
                };
              };
            }
          });
          return write(held);
        }, signal)
      );
    const stale = observe(
      invoke(IPC_CHANNELS.projectsMirrorCloud, {
        project: { ...mirrorInput.project, timelines: [] },
        includeContent: true
      })
    );
    await writing.promise;
    expect(inserts).toEqual([projects]);
    const changed = vi.fn();
    const switching = (
      scope === "library" ? f.choose() : f.retireAccount()
    ).then(changed);
    if (scope === "library") {
      await vi.waitFor(() =>
        expect(f.mirrors.libraryWork.signal.aborted).toBe(true)
      );
    }
    await flush();
    expect(changed).not.toHaveBeenCalled();
    gate.resolve();
    await switching;
    expect(await stale).toBeInstanceOf(Error);
    expect(inserts).toEqual([projects, cloudLinks]);
    expect(begin).toHaveBeenCalledOnce();
    if (scope === "library") {
      expect((await f.project()).name).toBe("library 1");
      await f.manager.open(f.roots[0]!);
    }
    expect((await f.project()).name).toBe("old mutation");
    expect(await f.manager.get().select().from(cloudLinks)).toMatchObject([
      { kind: "project", localId: "project", cloudId: "project" }
    ]);
  }
);

it("account retirement drains a cache-hit thumbnail write and blocks the source phase", async () => {
  const f = await fixture();
  const thumbnailUrl = url.replace("same.mp4", "thumbnail.jpg");
  await invoke(IPC_CHANNELS.projectsCacheCloudAsset, {
    ...cacheInput,
    sourceUrl: undefined,
    thumbnailUrl
  });
  f.fetchFromCloudStorage.mockClear();
  const gate = deferred();
  const writing = deferred();
  const db = f.manager.get();
  const update = db.update.bind(db);
  const writes = vi.spyOn(db, "update").mockImplementation((table) => {
    const query = update(table);
    const set = query.set.bind(query);
    vi.spyOn(query, "set").mockImplementation((values) => {
      const q = set(values);
      const where = q.where.bind(q);
      vi.spyOn(q, "where").mockImplementation((condition) => {
        const statement = where(condition);
        const execute = statement.execute.bind(statement);
        vi.spyOn(statement, "execute").mockImplementation(async () => {
          writing.resolve();
          await gate.promise;
          return execute();
        });
        return statement;
      });
      return q;
    });
    return query;
  });
  const stale = observe(
    invoke(IPC_CHANNELS.projectsCacheCloudAsset, {
      ...cacheInput,
      thumbnailUrl
    })
  );
  await writing.promise;
  const changed = vi.fn();
  const switching = f.retireAccount().then(changed);
  await flush();
  expect(changed).not.toHaveBeenCalled();
  gate.resolve();
  await switching;
  expect(await stale).toBeInstanceOf(Error);
  expect(writes).toHaveBeenCalledOnce();
  expect(f.fetchFromCloudStorage).not.toHaveBeenCalled();
  expect((await f.asset()).status).toBe("pending");
});

it.each(["mirror", "script"])(
  "drains %s late headers and actual delayed body cancellation",
  async (kind) => {
    const f = await fixture();
    const headers = deferred<Response>();
    const cancelled = deferred();
    const cancel = vi.fn(() => cancelled.promise);
    f.fetchFromCloudStorage.mockImplementationOnce(() => headers.promise);
    const stale = observe(kind === "mirror" ? f.cache() : f.scriptCache());
    await vi.waitFor(() =>
      expect(f.fetchFromCloudStorage).toHaveBeenCalledOnce()
    );
    let changed = false;
    const choosing = f.choose().then(() => {
      changed = true;
    });
    await vi.waitFor(() =>
      expect(f.mirrors.libraryWork.signal.aborted).toBe(true)
    );
    headers.resolve(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(changed).toBe(false);
    cancelled.resolve();
    await choosing;
    expect(await stale).toBeInstanceOf(Error);
    expect((await f.asset()).sourcePath).toBe("");
    expect(await f.manager.get().select().from(scriptProjectMedia)).toEqual([]);
    // Same IDs/URL must use replacement maps, never reuse an old result.
    await (kind === "mirror" ? f.cache() : f.scriptCache());
    expect(f.fetchFromCloudStorage).toHaveBeenCalledTimes(2);
  }
);

it.each(["mirror", "script", "mirror account"] as const)(
  "aborts and drains an already-reading %s body before replacement",
  async (kind) => {
    const f = await fixture();
    const cancelled = deferred();
    const cancel = vi.fn(() => cancelled.promise);
    const pull = vi.fn();
    f.fetchFromCloudStorage.mockResolvedValueOnce(
      new Response(new ReadableStream({ pull, cancel }))
    );
    const stale = observe(kind === "script" ? f.scriptCache() : f.cache());
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    let changed = false;
    const choosing = (
      kind === "mirror account" ? f.retireAccount() : f.choose()
    ).then(() => {
      changed = true;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await flush();
    expect(changed).toBe(false);
    cancelled.resolve();
    await choosing;
    expect(await stale).toBeInstanceOf(Error);
    expect((await f.asset()).status).toBe("pending");
    const files = await readdir(f.roots[0]!, { recursive: true });
    expect(files.some((file) => file.endsWith(".partial"))).toBe(false);
  }
);

it.each(["mirror", "script"])(
  "refuses %s transfer after a delayed repository root lookup",
  async (kind) => {
    const f = await fixture();
    const root = deferred<string>();
    f.getRoot.mockImplementationOnce(() => root.promise);
    const stale = observe(kind === "mirror" ? f.cache() : f.scriptCache());
    await vi.waitFor(() => expect(f.getRoot).toHaveBeenCalledOnce());
    const choosing = f.choose();
    await vi.waitFor(() =>
      expect(f.snapshots.libraryWork.signal.aborted).toBe(true)
    );
    root.resolve(f.roots[0]!);
    await choosing;
    expect(await stale).toBeInstanceOf(Error);
    expect(f.fetchFromCloudStorage).not.toHaveBeenCalled();
  }
);

it("drains all snapshot localization siblings after Promise.all rejects", async () => {
  const f = await fixture();
  const headers = deferred<Response>();
  const secondRoot = deferred<string>();
  f.getRoot
    .mockResolvedValueOnce(f.roots[0]!)
    .mockImplementationOnce(() => secondRoot.promise);
  f.fetchFromCloudStorage.mockImplementationOnce(() => headers.promise);
  const stale = observe(
    invoke(IPC_CHANNELS.scriptProjectsPut, {
      projectId: "project",
      intent: "cloud-import",
      state: { images: [{ url }, { url: url.replace("same", "second") }] }
    })
  );
  await vi.waitFor(() => expect(f.getRoot).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(f.fetchFromCloudStorage).toHaveBeenCalledOnce()
  );
  let changed = false;
  const choosing = f.choose().then(() => {
    changed = true;
  });
  await vi.waitFor(() =>
    expect(f.snapshots.libraryWork.signal.aborted).toBe(true)
  );
  secondRoot.resolve(f.roots[0]!);
  // The outer localization has rejected, but its first issued sibling is
  // still waiting for abort-ignoring headers. It must independently drain.
  expect(await stale).toBeInstanceOf(Error);
  expect(changed).toBe(false);
  headers.resolve(new Response("stale"));
  await choosing;
  expect((await f.snapshots.get("project"))?.state).toEqual({
    label: "library 1",
    url
  });
  expect(await f.manager.get().select().from(scriptProjectMedia)).toEqual([]);
});

it("does not start queued snapshot downloads after suspension", async () => {
  const f = await fixture();
  const responses: ReturnType<typeof deferred<Response>>[] = [];
  f.fetchFromCloudStorage.mockImplementation(() => {
    const response = deferred<Response>();
    responses.push(response);
    return response.promise;
  });
  const pending = Array.from({ length: 8 }, (_, index) =>
    observe(
      invoke(
        IPC_CHANNELS.scriptProjectsCacheMedia,
        "project",
        `${url}?ignored=${index}`.replace("same.mp4", `file-${index}.mp4`)
      )
    )
  );
  await vi.waitFor(() => expect(responses).toHaveLength(6));
  const choosing = f.choose();
  await vi.waitFor(() =>
    expect(f.snapshots.libraryWork.signal.aborted).toBe(true)
  );
  for (const response of responses) response.resolve(new Response("late"));
  await choosing;
  expect(
    (await Promise.all(pending)).every((error) => error instanceof Error)
  ).toBe(true);
  expect(f.fetchFromCloudStorage).toHaveBeenCalledTimes(6);
  f.fetchFromCloudStorage.mockResolvedValue(new Response("replacement"));
  await f.scriptCache();
  expect(f.fetchFromCloudStorage).toHaveBeenCalledTimes(7);
});

it.each([
  IPC_CHANNELS.scriptProjectsCacheMedia,
  IPC_CHANNELS.scriptProjectsPut
])(
  "production %s retains Director origin through an earlier account-mode wait",
  async (channel) => {
    const f = await fixture();
    const account = deferred<string>();
    f.mode.mockImplementationOnce(() => account.promise);
    const stale = observe(
      channel === IPC_CHANNELS.scriptProjectsPut
        ? invoke(channel, {
            projectId: "project",
            intent: "cloud-import",
            state: { changed: true, url }
          })
        : f.scriptCache()
    );
    await vi.waitFor(() => expect(f.mode).toHaveBeenCalledOnce());
    await f.choose();
    account.resolve("cloud");
    expect(await stale).toBeInstanceOf(Error);
    expect(f.fetchFromCloudStorage).not.toHaveBeenCalled();
    expect((await f.snapshots.get("project"))?.state).toEqual({
      label: "library 1",
      url
    });
  }
);

it.each(["open", "settings"])(
  "failed %s keeps both main repository owners and production IPC suspended",
  async (failure) => {
    const f = await fixture();
    if (failure === "open")
      vi.spyOn(f.manager, "open").mockRejectedValueOnce(
        new Error("open failed")
      );
    else f.setRoot.mockRejectedValueOnce(new Error("settings failed"));
    await expect(f.choose()).rejects.toThrow(`${failure} failed`);
    const before = f.mode.mock.calls.length;
    await expect(
      invoke(IPC_CHANNELS.projectsMirrorCloud, mirrorInput)
    ).rejects.toThrow();
    await expect(f.cache()).rejects.toThrow();
    await expect(f.scriptCache()).rejects.toThrow();
    await expect(
      invoke(IPC_CHANNELS.scriptProjectsPut, {
        projectId: "project",
        state: {}
      })
    ).rejects.toThrow();
    await expect(async () => f.snapshots.get("project")).rejects.toThrow();
    expect(f.mode).toHaveBeenCalledTimes(before);
    expect(f.fetchFromCloudStorage).not.toHaveBeenCalled();
  }
);

it("account-free snapshot reads preserve scoped cached media and uncached remote metadata", async () => {
  const f = await fixture();
  await f.scriptCache();
  f.mode.mockResolvedValue("offline");
  f.fetchFromCloudStorage.mockClear();
  const snapshot = (await invoke(
    IPC_CHANNELS.scriptProjectsGet,
    "project"
  )) as { state: { url: string } };
  expect(snapshot.state.url).toMatch(/^mago-media:\/\/script-project\//);
  const media = (await f.manager.get().select().from(scriptProjectMedia))[0]!;
  expect(
    await readFile(path.join(f.roots[0]!, media.relativePath), "utf8")
  ).toBe("video");
  await invoke(IPC_CHANNELS.scriptProjectsPut, {
    projectId: "project",
    state: { url: `${url}/uncached` }
  });
  expect((await f.snapshots.get("project"))?.state?.url).toBe(
    `${url}/uncached`
  );
  expect(f.fetchFromCloudStorage).not.toHaveBeenCalled();
});

it("late cached stat results cannot publish a snapshot from the old library", async () => {
  const f = await fixture();
  await f.scriptCache();
  const gate = deferred();
  vi.mocked(stat).mockClear();
  const originalStat = vi.mocked(stat).getMockImplementation()!;
  vi.mocked(stat).mockImplementationOnce(
    async (...args: Parameters<typeof stat>) => {
      const result = await originalStat(...args);
      await gate.promise;
      return result;
    }
  );
  const stale = observe(invoke(IPC_CHANNELS.scriptProjectsGet, "project"));
  await vi.waitFor(() => expect(stat).toHaveBeenCalled());
  const choosing = f.choose();
  await vi.waitFor(() =>
    expect(f.snapshots.libraryWork.signal.aborted).toBe(true)
  );
  gate.resolve();
  await choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect((await f.snapshots.get("project"))?.state).toEqual({
    label: "library 1",
    url
  });
});

it("stale detached cancel callbacks cannot cancel replacement operations with reused IDs", async () => {
  const f = await fixture();
  const delayed = deferred();
  const stale = observe(
    f.mirrors.libraryWork.run(async () => {
      await delayed.promise;
      f.mirrors.cancelAsset("project", "asset");
    })
  );
  await f.choose();
  const headers = deferred<Response>();
  f.fetchFromCloudStorage.mockImplementationOnce(() => headers.promise);
  const replacement = f.cache();
  await vi.waitFor(() =>
    expect(f.fetchFromCloudStorage).toHaveBeenCalledOnce()
  );
  delayed.resolve();
  expect(await stale).toBeInstanceOf(Error);
  expect(f.fetchFromCloudStorage.mock.calls[0]![1].signal?.aborted).toBe(false);
  headers.resolve(new Response("replacement"));
  await replacement;
  expect((await f.asset()).status).toBe("available");
});

it("coalesced mirror callers remain cancellable without dropping the first controller", async () => {
  const f = await fixture();
  const headers = deferred<Response>();
  f.fetchFromCloudStorage.mockImplementationOnce(() => headers.promise);
  const first = observe(f.cache());
  await vi.waitFor(() =>
    expect(f.fetchFromCloudStorage).toHaveBeenCalledOnce()
  );
  const second = observe(f.cache());
  await flush();
  await invoke(IPC_CHANNELS.projectsCancelCloudAsset, "project", "asset");
  expect(f.fetchFromCloudStorage.mock.calls[0]![1].signal?.aborted).toBe(true);
  headers.resolve(new Response("cancelled"));
  expect(await first).toBeInstanceOf(Error);
  expect(await second).toBeInstanceOf(Error);
  expect((await f.asset()).status).toBe("pending");
  await f.cache();
  expect(f.fetchFromCloudStorage).toHaveBeenCalledTimes(2);
});

it("complete issued snapshot writes drain before settings or DB replacement", async () => {
  const f = await fixture();
  // Pause an actual snapshot upsert, after ensureProject has already written.
  const gate = deferred();
  const get = f.manager.get.bind(f.manager);
  let writing = false;
  vi.spyOn(f.manager, "get").mockImplementation(() => {
    const db = get();
    return new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "insert") return Reflect.get(target, key, receiver);
        return (...args: Parameters<typeof db.insert>) => {
          const query = db.insert(...args);
          if (args[0] !== scriptProjectSnapshots) return query;
          const values = query.values.bind(query);
          return {
            values: (...input: Parameters<typeof values>) => {
              const q = values(...input);
              const update = q.onConflictDoUpdate.bind(q);
              return {
                onConflictDoUpdate: (
                  ...conflict: Parameters<typeof update>
                ) => ({
                  run: async () => {
                    writing = true;
                    await gate.promise;
                    await update(...conflict).run();
                  }
                })
              };
            }
          };
        };
      }
    });
  });
  const stale = observe(
    invoke(IPC_CHANNELS.scriptProjectsPut, {
      projectId: "project",
      metadataOnly: true,
      state: { label: "old write", url }
    })
  );
  await vi.waitFor(() => expect(writing).toBe(true));
  const choosing = f.choose();
  await vi.waitFor(() =>
    expect(f.snapshots.libraryWork.signal.aborted).toBe(true)
  );
  expect(f.setRoot).not.toHaveBeenCalled();
  gate.resolve();
  await choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect((await f.snapshots.get("project"))?.state).toEqual({
    label: "library 1",
    url
  });
  await f.manager.open(f.roots[0]!);
  expect((await f.snapshots.get("project"))?.state).toEqual({
    label: "old write",
    url
  });
});

it("local generated media file and row writes drain together", async () => {
  const f = await fixture();
  const root = deferred<string>();
  f.getRoot.mockImplementationOnce(() => root.promise);
  const stale = observe(
    f.snapshots.storeGeneratedMedia(
      "project",
      Buffer.from("old generated"),
      "mp4"
    )
  );
  await vi.waitFor(() => expect(f.getRoot).toHaveBeenCalledOnce());
  const choosing = f.choose();
  await vi.waitFor(() =>
    expect(f.snapshots.libraryWork.signal.aborted).toBe(true)
  );
  root.resolve(f.roots[0]!);
  await choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect(await f.manager.get().select().from(scriptProjectMedia)).toEqual([]);
  await f.manager.open(f.roots[0]!);
  const rows = await f.manager.get().select().from(scriptProjectMedia);
  expect(rows).toHaveLength(1);
  expect(
    await readFile(path.join(f.roots[0]!, rows[0]!.relativePath), "utf8")
  ).toBe("old generated");
});

it("reused local script-media IDs cannot return replacement paths to old requests", async () => {
  const f = await fixture();
  for (const [index, root] of f.roots.entries()) {
    await f.manager.open(root);
    await writeFile(path.join(root, "same.mp4"), `local ${index}`);
    await f.manager.get().insert(scriptProjectMedia).values({
      id: "same",
      projectId: "project",
      relativePath: "same.mp4",
      sourceUrl: "local-generated:same"
    });
  }
  await f.manager.open(f.roots[0]!);
  const root = deferred<string>();
  f.getRoot.mockImplementationOnce(() => root.promise);
  const stale = observe(f.snapshots.resolveMediaPath("same"));
  await vi.waitFor(() => expect(f.getRoot).toHaveBeenCalledOnce());
  const choosing = f.choose();
  await vi.waitFor(() =>
    expect(f.snapshots.libraryWork.signal.aborted).toBe(true)
  );
  root.resolve(f.roots[0]!);
  await choosing;
  expect(await stale).toBeInstanceOf(Error);
  const source = await f.snapshots.resolveMediaPath("same");
  expect(source).toBe(path.join(f.roots[1]!, "same.mp4"));
  expect(await readFile(source!, "utf8")).toBe("local 1");
});
