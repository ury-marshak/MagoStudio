import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  choose: vi.fn()
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.choose },
  shell: {}
}));

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS } from "../../shared/contracts";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import {
  assets,
  clips,
  cloudLinks,
  cloudRenderJobs,
  projects,
  shots,
  tracks
} from "../database/schema";
import type { ImageRenderService } from "../imageRenders/imageRenderService";
import { registerCloudHandlers } from "../ipc/registerCloudHandlers";
import { registerImageRenderHandlers } from "../ipc/registerImageRenderHandlers";
import { registerLibraryHandlers } from "../ipc/registerLibraryHandlers";
import type { LibrarySettings } from "../librarySettings";
import { LibraryWorkSession } from "../libraryWorkSession";

import { CloudLinkRepository } from "./cloudLinkRepository";
import { CloudRenderJobRepository } from "./cloudRenderJobRepository";
import type { CloudRenderSubmitService } from "./cloudRenderSubmitService";
import type { UploadService } from "./uploadService";

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
const observe = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );
const event = {
  senderFrame: { url: `https://${resolveCloudConfig().rendererHost}/` },
  sender: { isDestroyed: () => false, send: vi.fn() }
};
const invoke = async (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!(event, ...args);
const directories: string[] = [];
const managers: DatabaseManager[] = [];
const jobInput = {
  id: "job",
  model: "cloud",
  projectId: "project",
  shotId: "shot",
  trackId: "track",
  clipId: "clip",
  assetId: "asset",
  request: {}
};

beforeEach(() => {
  mocks.handlers.clear();
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

const fixture = async () => {
  const roots = await Promise.all(
    [0, 1].map(() => mkdtemp(path.join(tmpdir(), "mago-bookkeeping-owner-")))
  );
  directories.push(...roots);
  const manager = new DatabaseManager();
  managers.push(manager);
  const links = new CloudLinkRepository(manager);
  const jobs = new CloudRenderJobRepository(manager);
  for (const [index, root] of roots.entries()) {
    await manager.open(root);
    const db = manager.get();
    await db
      .insert(projects)
      .values({ id: "project", name: `library ${index}` });
    await db
      .insert(shots)
      .values({ id: "shot", projectId: "project", name: `shot ${index}` });
    await db.insert(tracks).values({
      id: "track",
      projectId: "project",
      shotId: "shot",
      name: `track ${index}`,
      type: "MAGOV2"
    });
    await db.insert(assets).values({
      id: "asset",
      name: "output",
      type: "video",
      sourcePath: "pending",
      status: "PENDING",
      dataJson: JSON.stringify({ preserved: index })
    });
    await db.insert(clips).values({
      id: "clip",
      trackId: "track",
      assetId: "asset",
      name: "output",
      dataJson: JSON.stringify({ preserved: index })
    });
    await jobs.create(jobInput);
    await links.put({
      kind: "project",
      localId: "project",
      cloudId: `remote ${index}`,
      data: { preserved: index }
    });
  }
  let root = roots[0]!;
  await manager.open(root);
  const settings = {
    getLibraryRoot: vi.fn(async () => root),
    getAppMode: vi.fn(async () => "offline"),
    assertWritable: vi.fn(async () => {}),
    setLibraryRoot: vi.fn(async (next: string) => {
      root = next;
    })
  };
  const service = {
    cancel: vi.fn(async () => {}),
    markInteracted: vi.fn(async () => {})
  };
  registerCloudHandlers({
    links,
    renderJobs: jobs,
    uploads: {} as UploadService,
    repository: new ProjectRepository(manager, settings.getLibraryRoot),
    renderSubmits: {
      libraryWork: new LibraryWorkSession(() => undefined)
    } as CloudRenderSubmitService,
    databaseManager: manager,
    getLibraryRoot: settings.getLibraryRoot,
    settings: settings as unknown as LibrarySettings
  });
  registerImageRenderHandlers(service as unknown as ImageRenderService, jobs);
  const suspend = () =>
    Promise.all([links.libraryWork.suspend(), jobs.libraryWork.suspend()]);
  const reset = () => {
    links.libraryWork.reset();
    jobs.libraryWork.reset();
  };
  registerLibraryHandlers({
    settings: settings as unknown as LibrarySettings,
    databaseManager: manager,
    repository: {} as ProjectRepository,
    beforeLibraryChange: async () => {
      await suspend();
    },
    afterLibraryChange: reset
  });
  mocks.choose.mockResolvedValue({ canceled: false, filePaths: [roots[1]] });

  // Delay actual Drizzle query execution, not a repository mock. Each query
  // still executes against its real originating SQLite database.
  let beforeQuery = async (_sql: string) => {};
  const wrap = <T extends object>(object: T): T =>
    new Proxy(object, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (key === "then" && typeof value === "function") {
          return (...args: unknown[]) => {
            const pending = (async () => {
              await beforeQuery(
                (target as unknown as { toSQL: () => { sql: string } }).toSQL()
                  .sql
              );
              return await (target as unknown as PromiseLike<unknown>);
            })();
            return Reflect.apply(pending.then, pending, args);
          };
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return result && typeof result === "object" ? wrap(result) : result;
        };
      }
    });
  const get = manager.get.bind(manager);
  vi.spyOn(manager, "get").mockImplementation(() => wrap(get()));
  const transaction = manager.transaction.bind(manager);
  vi.spyOn(manager, "transaction").mockImplementation((operation) =>
    transaction((db) => operation(wrap(db)))
  );
  const choose = () => invoke(IPC_CHANNELS.libraryChoose);
  const delay = (predicate: (sql: string) => boolean) => {
    const gate = deferred();
    const entered = vi.fn();
    beforeQuery = async (sql) => {
      if (predicate(sql)) {
        entered(sql);
        await gate.promise;
      }
    };
    return { ...gate, entered };
  };
  const startSwitch = async () => {
    let changed = false;
    const choosing = choose().then(() => {
      changed = true;
    });
    await vi.waitFor(() => expect(jobs.libraryWork.signal.aborted).toBe(true));
    await flush();
    return { choosing, changed: () => changed };
  };
  return {
    roots,
    manager,
    links,
    jobs,
    settings,
    service,
    choose,
    suspend,
    reset,
    delay,
    startSwitch,
    setQueryHook: (hook: typeof beforeQuery) => {
      beforeQuery = hook;
    }
  };
};

const requests: Array<[string, unknown[]]> = [
  [IPC_CHANNELS.cloudLinkGet, ["project", "project"]],
  [
    IPC_CHANNELS.cloudLinkPut,
    [{ kind: "project", localId: "project", cloudId: "changed" }]
  ],
  [
    IPC_CHANNELS.cloudLinkPatch,
    [{ kind: "project", localId: "project", patch: { changed: true } }]
  ],
  [IPC_CHANNELS.cloudRenderListActive, []],
  [IPC_CHANNELS.cloudRenderListQueue, []],
  [
    IPC_CHANNELS.cloudRenderSetStatus,
    [{ jobId: "job", status: "INPROGRESS", progress: 50 }]
  ],
  [IPC_CHANNELS.imageRendersCancel, ["job"]],
  [IPC_CHANNELS.imageRendersMarkInteracted, ["job"]]
];

it.each(requests)(
  "drains issued production %s and suppresses its stale result",
  async (channel, args) => {
    const f = await fixture();
    let first = true;
    const gate = f.delay(() => {
      if (!first) return false;
      first = false;
      return true;
    });
    const stale = observe(invoke(channel, ...args));
    await vi.waitFor(() => expect(gate.entered).toHaveBeenCalledOnce());
    const switching = await f.startSwitch();
    expect(switching.changed()).toBe(false);
    gate.resolve();
    await switching.choosing;
    expect(await stale).toBeInstanceOf(Error);
    expect(await f.jobs.get("job")).toMatchObject({
      status: "PENDING",
      progress: 0
    });
    expect(await f.links.get("project", "project")).toMatchObject({
      cloudId: "remote 1",
      data: { preserved: 1 }
    });
    expect((await f.jobs.listQueue())[0]).toMatchObject({
      project_name: "library 1",
      interacted_with: false
    });
  }
);

it("drains the full issued link read/merge/write, not just its first query", async () => {
  const f = await fixture();
  const gate = f.delay((sql) => sql.startsWith('insert into "cloud_links"'));
  const stale = observe(
    invoke(IPC_CHANNELS.cloudLinkPatch, {
      kind: "project",
      localId: "project",
      patch: { changed: true }
    })
  );
  await vi.waitFor(() => expect(gate.entered).toHaveBeenCalledOnce());
  const switching = await f.startSwitch();
  expect(switching.changed()).toBe(false);
  gate.resolve();
  await switching.choosing;
  expect(await stale).toBeInstanceOf(Error);
  await f.manager.open(f.roots[0]!);
  expect(await f.links.get("project", "project")).toMatchObject({
    cloudId: "remote 0",
    data: { preserved: 0, changed: true }
  });
});

it("finishes issued cancellation transaction through asset and clip bookkeeping", async () => {
  const f = await fixture();
  const gate = f.delay((sql) => sql.startsWith('update "assets"'));
  const stale = observe(invoke(IPC_CHANNELS.imageRendersCancel, "job"));
  await vi.waitFor(() => expect(gate.entered).toHaveBeenCalledOnce());
  const switching = await f.startSwitch();
  expect(switching.changed()).toBe(false);
  gate.resolve();
  await switching.choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect(await f.manager.get().select().from(assets)).toMatchObject([
    { status: "PENDING", dataJson: '{"preserved":1}' }
  ]);
  await f.manager.open(f.roots[0]!);
  expect(await f.jobs.get("job")).toMatchObject({ status: "CANCELLED" });
  expect(await f.manager.get().select().from(assets)).toMatchObject([
    {
      status: "CANCELLED",
      dataJson: '{"preserved":0,"queue_status":"CANCELLED"}'
    }
  ]);
  expect(await f.manager.get().select().from(clips)).toMatchObject([
    { dataJson: '{"preserved":0,"status":"cancelled"}' }
  ]);
});

it("drains queue hydration siblings after another query rejects", async () => {
  const f = await fixture();
  const gate = deferred();
  const entered = vi.fn();
  f.setQueryHook(async (sql) => {
    if (sql.includes('from "shots"')) {
      entered();
      await gate.promise;
    }
    if (sql.includes('from "projects"'))
      throw new Error("fixture query failure");
  });
  const stale = observe(invoke(IPC_CHANNELS.cloudRenderListQueue));
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  expect(await stale).toBeInstanceOf(Error);
  const switching = await f.startSwitch();
  expect(switching.changed()).toBe(false);
  gate.resolve();
  await switching.choosing;
});

it.each(["cancel", "markInteracted"] as const)(
  "retains origin across local %s without draining the service/provider wait",
  async (method) => {
    const f = await fixture();
    const gate = deferred();
    f.service[method].mockImplementationOnce(() => gate.promise);
    const stale = observe(
      invoke(
        method === "cancel"
          ? IPC_CHANNELS.imageRendersCancel
          : IPC_CHANNELS.imageRendersMarkInteracted,
        "job"
      )
    );
    await vi.waitFor(() => expect(f.service[method]).toHaveBeenCalledOnce());
    await f.choose();
    gate.resolve();
    expect(await stale).toBeInstanceOf(Error);
    expect((await f.jobs.listQueue())[0]).toMatchObject({
      status: "PENDING",
      interacted_with: false
    });
    expect(f.service.cancel).toHaveBeenCalledTimes(method === "cancel" ? 1 : 0);
  }
);

it.each(["link", "job"])(
  "drains issued %s deletion only in the originating library",
  async (kind) => {
    const f = await fixture();
    const gate = f.delay((sql) => sql.startsWith("delete from"));
    const stale = observe(
      kind === "link"
        ? f.links.delete("project", "project")
        : f.jobs.deleteForClip("clip")
    );
    await vi.waitFor(() => expect(gate.entered).toHaveBeenCalledOnce());
    const switching = await f.startSwitch();
    expect(switching.changed()).toBe(false);
    gate.resolve();
    await switching.choosing;
    expect(await stale).toBeInstanceOf(Error);
    expect(await f.links.get("project", "project")).not.toBeNull();
    expect(await f.jobs.get("job")).not.toBeNull();
    await f.manager.open(f.roots[0]!);
    expect(
      kind === "link"
        ? await f.links.get("project", "project")
        : await f.jobs.get("job")
    ).toBeNull();
  }
);

it.each(["open", "settings"])(
  "keeps fresh production bookkeeping suspended after failed %s",
  async (failure) => {
    const f = await fixture();
    if (failure === "open")
      vi.spyOn(f.manager, "open").mockRejectedValueOnce(
        new Error("fixture open")
      );
    else
      f.settings.setLibraryRoot.mockRejectedValueOnce(
        new Error("fixture settings")
      );
    await expect(f.choose()).rejects.toThrow(`fixture ${failure}`);
    for (const [channel, args] of requests)
      await expect(invoke(channel, ...args)).rejects.toThrow();
    expect(f.service.cancel).not.toHaveBeenCalled();
    expect(f.service.markInteracted).not.toHaveBeenCalled();
  }
);

it("preserves account-free links, queue history, status, and explicit user cancellation", async () => {
  const f = await fixture();
  await invoke(IPC_CHANNELS.cloudLinkPatch, {
    kind: "project",
    localId: "project",
    patch: { cached: true }
  });
  await invoke(IPC_CHANNELS.cloudRenderSetStatus, {
    jobId: "job",
    status: "INPROGRESS",
    progress: 20
  });
  expect(await invoke(IPC_CHANNELS.cloudRenderListActive)).toMatchObject([
    { id: "job", status: "INPROGRESS" }
  ]);
  await invoke(IPC_CHANNELS.imageRendersCancel, "job");
  await invoke(IPC_CHANNELS.imageRendersMarkInteracted, "job");
  expect(await invoke(IPC_CHANNELS.cloudRenderListActive)).toEqual([]);
  expect(await invoke(IPC_CHANNELS.cloudRenderListQueue)).toMatchObject([
    { id: "job", status: "CANCELLED", interacted_with: true }
  ]);
  expect(
    await invoke(IPC_CHANNELS.cloudLinkGet, "project", "project")
  ).toMatchObject({ data: { preserved: 0, cached: true } });
  expect(f.settings.getAppMode).not.toHaveBeenCalled();
  expect(f.service.cancel).toHaveBeenCalledOnce();
});

it("refuses untrusted production bookkeeping without local service side effects", async () => {
  const f = await fixture();
  for (const [channel, args] of requests) {
    await expect(
      mocks.handlers.get(channel)!(
        { ...event, senderFrame: { url: "https://untrusted.invalid" } },
        ...args
      )
    ).rejects.toThrow();
  }
  expect(f.service.cancel).not.toHaveBeenCalled();
  expect(
    await f.manager
      .get()
      .select()
      .from(cloudRenderJobs)
      .where(eq(cloudRenderJobs.id, "job"))
  ).toMatchObject([{ status: "PENDING" }]);
  expect(await f.manager.get().select().from(cloudLinks)).toMatchObject([
    { cloudId: "remote 0" }
  ]);
});

it("resets bookkeeping only after successful settings persistence", async () => {
  const f = await fixture();
  const gate = deferred();
  f.settings.setLibraryRoot.mockImplementationOnce(() => gate.promise);
  const choosing = f.choose();
  await vi.waitFor(() =>
    expect(f.settings.setLibraryRoot).toHaveBeenCalledOnce()
  );
  for (const [channel, args] of requests)
    await expect(invoke(channel, ...args)).rejects.toThrow();
  expect(f.service.cancel).not.toHaveBeenCalled();
  gate.resolve();
  await choosing;
  expect(await invoke(IPC_CHANNELS.cloudRenderListQueue)).toMatchObject([
    { project_name: "library 1" }
  ]);
  expect(
    await invoke(IPC_CHANNELS.cloudLinkGet, "project", "project")
  ).toMatchObject({ cloudId: "remote 1" });
});

it("library teardown alone never performs explicit cancellation or changes accepted jobs", async () => {
  const f = await fixture();
  await f.jobs.update("job", {
    cloudAssetId: "accepted",
    status: "INPROGRESS"
  });
  await f.choose();
  expect(f.service.cancel).not.toHaveBeenCalled();
  expect(f.service.markInteracted).not.toHaveBeenCalled();
  expect(await f.jobs.get("job")).toMatchObject({ status: "PENDING" });
  await f.manager.open(f.roots[0]!);
  expect(await f.jobs.get("job")).toMatchObject({
    status: "INPROGRESS",
    cloudAssetId: "accepted"
  });
});

it("drains direct repository creation without overwriting the reused replacement job", async () => {
  const f = await fixture();
  await f.jobs.deleteForClip("clip");
  const gate = f.delay((sql) =>
    sql.startsWith('insert into "cloud_render_jobs"')
  );
  const stale = observe(
    f.jobs.create({ ...jobInput, cloudAssetId: "old submitted asset" })
  );
  await vi.waitFor(() => expect(gate.entered).toHaveBeenCalledOnce());
  const switching = await f.startSwitch();
  expect(switching.changed()).toBe(false);
  gate.resolve();
  await switching.choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect(await f.jobs.get("job")).toMatchObject({ cloudAssetId: null });
  await f.manager.open(f.roots[0]!);
  expect(await f.jobs.get("job")).toMatchObject({
    cloudAssetId: "old submitted asset"
  });
});

it("drains a direct job read and refuses its stale cached result", async () => {
  const f = await fixture();
  const gate = f.delay((sql) => sql.includes('from "cloud_render_jobs"'));
  const stale = observe(f.jobs.get("job"));
  await vi.waitFor(() => expect(gate.entered).toHaveBeenCalledOnce());
  const switching = await f.startSwitch();
  expect(switching.changed()).toBe(false);
  gate.resolve();
  await switching.choosing;
  expect(await stale).toBeInstanceOf(Error);
  expect(await f.jobs.get("job")).toMatchObject({ status: "PENDING" });
});

it("old detached link continuations cannot acquire the replacement repository session", async () => {
  const f = await fixture();
  const gate = deferred();
  const entered = deferred();
  const stale = observe(
    f.links.libraryWork.run(async () => {
      entered.resolve();
      await gate.promise;
      await f.links.put({
        kind: "project",
        localId: "project",
        cloudId: "late old result"
      });
    })
  );
  await entered.promise;
  await f.choose();
  gate.resolve();
  expect(await stale).toBeInstanceOf(Error);
  expect(await f.links.get("project", "project")).toMatchObject({
    cloudId: "remote 1"
  });
});
