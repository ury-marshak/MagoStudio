import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MagoDesktopApi } from "../../shared/contracts";

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  sender: null as any,
  api: null as unknown as MagoDesktopApi,
  folder: "",
  profile: "",
  cancelled: false,
  saveDialog: vi.fn(),
  beforeRename: vi.fn<() => Promise<void>>()
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async rename(...args: Parameters<typeof fs.rename>) {
      if (String(args[0]).endsWith(".partial")) await fixture.beforeRename();
      return fs.rename(...args);
    }
  };
});
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => fixture.profile
  },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) =>
      fixture.handlers.set(name, handler)
  },
  ipcRenderer: {
    invoke: async (name: string, ...args: unknown[]) =>
      fixture.handlers.get(name)!(
        {
          sender: fixture.sender,
          senderFrame: { url: "http://localhost:3000/" }
        },
        ...args
      ),
    on: (name: string, listener: (...args: any[]) => any) =>
      fixture.listeners.set(name, listener)
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MagoDesktopApi) => {
      fixture.api = api;
    }
  },
  webUtils: {},
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: {
    showOpenDialog: async () => ({
      canceled: fixture.cancelled,
      filePaths: [fixture.folder]
    }),
    showSaveDialog: fixture.saveDialog
  },
  shell: {}
}));

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { CloudProjectMirrorRepository } from "../database/cloudProjectMirrorRepository";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { projects, scriptProjectSnapshots } from "../database/schema";
import { LibrarySettings } from "../librarySettings";
import { LibraryWorkSession } from "../libraryWorkSession";

import { registerCloudStorageHandlers } from "./registerCloudStorageHandlers";
import { registerLibraryHandlers } from "./registerLibraryHandlers";
import { registerProjectHandlers } from "./registerProjectHandlers";
import { registerRendererLibraryLifecycle } from "./rendererLibraryLifecycle";

const directories: string[] = [];
const managers: DatabaseManager[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const event = (sender = fixture.sender, url = "http://localhost:3000/") => ({
  sender,
  senderFrame: { url }
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

beforeEach(async () => {
  vi.resetModules();
  fixture.handlers.clear();
  fixture.listeners.clear();
  fixture.cancelled = false;
  fixture.saveDialog.mockReset();
  fixture.beforeRename.mockReset();
  fixture.sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn((channel: string, ...args: unknown[]) =>
      fixture.listeners.get(channel)?.({}, ...args)
    )
  });
  fixture.folder = "/replacement";
  await import("../../preload/preload.js");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setupCloudSave = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mago-cloud-save-libraries-"));
  directories.push(root);
  fixture.profile = root;
  const [original, replacement] = [path.join(root, "a"), path.join(root, "b")];
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ libraryRoot: original, appMode: "cloud" })
  );
  const settings = new LibrarySettings();
  const manager = new DatabaseManager();
  managers.push(manager);
  await manager.open(original);
  fixture.folder = replacement;
  const libraryWork = new LibraryWorkSession(() => undefined);
  const lifecycle = registerLibraryHandlers({
    settings,
    databaseManager: manager,
    repository: new ProjectRepository(manager, () => settings.getLibraryRoot()),
    mediaWork: libraryWork,
    beforeLibraryChange: () => libraryWork.suspend(),
    afterLibraryChange: () => libraryWork.reset()
  });
  const profile = new AbortController();
  registerCloudStorageHandlers(settings, {
    libraryWork,
    assertLibraryAvailable: () => lifecycle.assertAvailable(),
    captureAccountProfile: () => profile.signal
  });
  const rendererDrained = vi.fn(async () => {});
  await fixture.api.library.onWillChange(rendererDrained);
  const url = `https://${resolveCloudConfig().cloudStorageHosts[0]}/history.mp4`;
  return {
    root,
    settings,
    manager,
    original,
    replacement,
    rendererDrained,
    profile,
    input: { url, suggestedName: "history.mp4" },
    destination: path.join(root, "history.mp4")
  };
};

it("reports a committed cloud Save As when an issued rename completes during library teardown", async () => {
  const { manager, replacement, input, destination } = await setupCloudSave();
  fixture.saveDialog.mockResolvedValue({
    canceled: false,
    filePath: destination
  });
  const finishRename = deferred();
  fixture.beforeRename.mockReturnValue(finishRename.promise);
  const fetchTrap = vi.fn(
    async (_url: URL, _init: RequestInit) => new Response("committed export")
  );
  vi.stubGlobal("fetch", fetchTrap);
  const save = fixture.api.files.saveCloudStorageObjectAs(input);
  const open = vi.spyOn(manager, "open");
  let change: ReturnType<typeof fixture.api.library.choose> | undefined;
  try {
    await vi.waitFor(() => expect(fixture.beforeRename).toHaveBeenCalledOnce());
    change = fixture.api.library.choose();
    await vi.waitFor(() =>
      expect(fetchTrap.mock.calls[0][1].signal?.aborted).toBe(true)
    );
    expect(open).not.toHaveBeenCalled();
  } finally {
    finishRename.resolve();
    await Promise.allSettled([save, change]);
  }
  await expect(save).resolves.toBe(true);
  await expect(change).resolves.toMatchObject({ rootPath: replacement });
  expect(await readFile(destination, "utf8")).toBe("committed export");
});

it("does not fetch or write when cloud Save As is approved after a same-account library switch", async () => {
  const { settings, replacement, input, destination, profile } =
    await setupCloudSave();
  const dialog = deferred();
  fixture.saveDialog.mockImplementation(async () => {
    await dialog.promise;
    return { canceled: false, filePath: destination };
  });
  const fetchTrap = vi.fn(async () => new Response("mock download"));
  vi.stubGlobal("fetch", fetchTrap);
  const save = fixture.api.files.saveCloudStorageObjectAs(input);
  try {
    await vi.waitFor(() => expect(fixture.saveDialog).toHaveBeenCalledOnce());
    await expect(fixture.api.library.choose()).resolves.toMatchObject({
      rootPath: replacement
    });
    expect(await settings.getAppMode()).toBe("cloud");
    expect(profile.signal.aborted).toBe(false);
  } finally {
    dialog.resolve();
  }
  expect(await save).toBe(false);
  expect(fetchTrap).not.toHaveBeenCalled();
  await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fixture.api.files.saveCloudStorageObjectAs(input)).resolves.toBe(
    true
  );
  expect(await readFile(destination, "utf8")).toBe("mock download");
});

it("aborts and drains an issued cloud Save As body and partial file before opening another library", async () => {
  const {
    root,
    manager,
    settings,
    original,
    replacement,
    rendererDrained,
    input,
    destination
  } = await setupCloudSave();
  await writeFile(destination, "existing export");
  fixture.saveDialog.mockResolvedValue({
    canceled: false,
    filePath: destination
  });
  const finishCancel = deferred();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(() => finishCancel.promise);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
        controller.enqueue(new TextEncoder().encode("incomplete export"));
      },
      cancel
    })
  );
  const fetchTrap = vi.fn(async (_url: URL, _init: RequestInit) => response);
  vi.stubGlobal("fetch", fetchTrap);
  const save = fixture.api.files.saveCloudStorageObjectAs(input);
  let change: ReturnType<typeof fixture.api.library.choose> | undefined;
  const openActual = manager.open.bind(manager);
  const open = vi.spyOn(manager, "open").mockImplementation(async (library) => {
    expect(await readdir(root)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.partial$/)])
    );
    return openActual(library);
  });
  try {
    await vi.waitFor(async () =>
      expect(
        (await readdir(root)).some((entry) => entry.endsWith(".partial"))
      ).toBe(true)
    );
    change = fixture.api.library.choose();
    await vi.waitFor(() => expect(rendererDrained).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetchTrap.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(await settings.getLibraryRoot()).toBe(original);
  } finally {
    if (!cancel.mock.calls.length) body.close();
    finishCancel.resolve();
    await Promise.allSettled([save, change]);
  }
  await expect(save).resolves.toBe(false);
  await expect(change).resolves.toMatchObject({ rootPath: replacement });
  expect(await readFile(destination, "utf8")).toBe("existing export");
  expect(
    (await readdir(root)).filter((entry) => entry.endsWith(".partial"))
  ).toEqual([]);
});

it("composes actual preload drains before opening a reused-ID SQLite library and resets only after settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mago-renderer-libraries-"));
  directories.push(root);
  const manager = new DatabaseManager();
  managers.push(manager);
  const roots = [path.join(root, "a"), path.join(root, "b")];
  for (const library of roots) {
    await manager.open(library);
    await manager.get().insert(projects).values({
      id: "reused",
      name: library,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  await manager.open(roots[0]);
  fixture.folder = roots[1];
  const drain = deferred();
  const order: string[] = [];
  let rootPath = roots[0];
  registerLibraryHandlers({
    settings: {
      assertWritable: async () => {},
      getLibraryRoot: async () => rootPath,
      setLibraryRoot: async (value: string) => {
        order.push("settings");
        rootPath = value;
      }
    },
    databaseManager: manager,
    repository: new ProjectRepository(manager, async () => rootPath),
    beforeLibraryChange: async () => {
      order.push("main-suspend");
    },
    afterLibraryChange: () => {
      order.push("main-reset");
    }
  } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
  await fixture.api.library.onWillChange(async () => {
    order.push("renderer-suspend");
    await drain.promise;
    order.push("renderer-drained");
  });
  fixture.api.library.onDidChange(() => {
    order.push("renderer-reset");
  });
  const change = fixture.api.library.choose();
  await vi.waitFor(() => expect(order).toEqual(["renderer-suspend"]));
  expect((await manager.get().select().from(projects))[0].name).toBe(roots[0]);
  drain.resolve();
  await change;
  expect((await manager.get().select().from(projects))[0].name).toBe(roots[1]);
  expect(order).toEqual([
    "renderer-suspend",
    "renderer-drained",
    "main-suspend",
    "settings",
    "main-reset",
    "renderer-reset"
  ]);
});

it("drains an issued legacy setting seed into the old database and refuses generic requests through handoff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mago-generic-project-read-"));
  directories.push(root);
  const manager = new DatabaseManager();
  managers.push(manager);
  const roots = [path.join(root, "a"), path.join(root, "b")];
  for (const library of roots) {
    await manager.open(library);
    await manager
      .get()
      .insert(projects)
      .values({
        id: "reused",
        name: library,
        settingsJson: JSON.stringify({ type: "script_to_shots" }),
        createdAt: new Date(),
        updatedAt: new Date()
      });
    await manager
      .get()
      .insert(scriptProjectSnapshots)
      .values({
        projectId: "reused",
        stateJson: JSON.stringify({ visual_style: library }),
        updatedAt: new Date()
      });
  }
  await manager.open(roots[0]);
  fixture.folder = roots[1];
  let current = roots[0]!;
  const resolveRoot = vi.fn(async () => current);
  const settings = {
    assertWritable: async () => {},
    getLibraryRoot: resolveRoot,
    setLibraryRoot: async (path: string) => {
      current = path;
    }
  } as unknown as LibrarySettings;
  const repository = new ProjectRepository(manager, resolveRoot);
  const work = new LibraryWorkSession(() => undefined);
  const renderDrain = deferred();
  const seed = deferred();
  const dispatched = deferred();
  const seedSetting = repository.setSettingIfAbsent.bind(repository);
  vi.spyOn(repository, "setSettingIfAbsent").mockImplementationOnce(
    async (...args) => {
      dispatched.resolve();
      await seed.promise;
      return seedSetting(...args);
    }
  );
  const lifecycle = registerLibraryHandlers({
    settings,
    databaseManager: manager,
    repository,
    beforeLibraryChange: () => work.suspend(),
    afterLibraryChange: () => work.reset()
  });
  registerProjectHandlers(
    repository,
    new CloudProjectMirrorRepository(manager, resolveRoot),
    manager,
    settings,
    undefined,
    work,
    work,
    undefined,
    () => lifecycle.assertAvailable()
  );
  await fixture.api.library.onWillChange(() => renderDrain.promise);
  const old = fixture.api.projects.get("reused");
  const refused = expect(old).rejects.toMatchObject({ name: "AbortError" });
  await dispatched.promise;
  const change = fixture.api.library.choose();
  const open = vi.spyOn(manager, "open");
  await vi.waitFor(() =>
    expect(fixture.sender.send).toHaveBeenCalledWith(
      "library:will-change",
      expect.any(String),
      expect.any(String)
    )
  );
  await expect(fixture.api.projects.list()).rejects.toMatchObject({
    name: "AbortError"
  });
  renderDrain.resolve();
  await flush();
  expect(open).not.toHaveBeenCalled();
  seed.resolve();
  await refused;
  await change;
  const [beforeRead] = await manager.get().select().from(projects);
  expect(JSON.parse(beforeRead!.settingsJson)).not.toHaveProperty(
    "visual_style"
  );
  const replacement = await fixture.api.projects.get("reused");
  expect(replacement).toMatchObject({ name: roots[1] });
  await manager.open(roots[0]);
  const [oldProject] = await manager.get().select().from(projects);
  expect(JSON.parse(oldProject!.settingsJson)).toHaveProperty(
    "visual_style",
    roots[0]
  );
});

it("requires both the trusted sender and its exact nonce before acknowledging a drain", async () => {
  const lifecycle = registerRendererLibraryLifecycle();
  const watch = fixture.handlers.get("library:watch")!;
  const ack = fixture.handlers.get("library:drained")!;
  expect(() => watch(event(fixture.sender, "https://evil.invalid"))).toThrow(
    "untrusted"
  );
  const drain = deferred();
  await fixture.api.library.onWillChange(() => drain.promise);
  let finished = false;
  const suspension = lifecycle.suspend().then(() => {
    finished = true;
  });
  const nonce = fixture.sender.send.mock.calls.at(-1)![1];
  const document = fixture.sender.send.mock.calls.at(-1)![2];
  ack(event(), "wrong", false, document);
  ack(event(), nonce, false, "different-document");
  ack(event({}), nonce, false, document);
  expect(() =>
    ack(event(fixture.sender, "https://evil.invalid"), nonce, false, document)
  ).toThrow("untrusted");
  await flush();
  expect(finished).toBe(false);
  drain.resolve();
  await suspension;
  lifecycle.reset();
});

it("fails closed on a rejected renderer drain and does not permit another change without reset", async () => {
  const lifecycle = registerRendererLibraryLifecycle();
  await fixture.api.library.onWillChange(async () => {
    throw new Error("cannot drain");
  });
  const reset = vi.fn();
  fixture.api.library.onDidChange(reset);
  await expect(lifecycle.suspend()).rejects.toThrow("teardown failed");
  await expect(lifecycle.suspend()).rejects.toThrow("already in progress");
  expect(reset).not.toHaveBeenCalled();
});

it("refuses database opening when a renderer never acknowledges", async () => {
  vi.useFakeTimers();
  const lifecycle = registerRendererLibraryLifecycle();
  fixture.handlers.get("library:watch")!(event(), "before");
  fixture.listeners.delete("library:will-change");
  const suspension = lifecycle.suspend();
  const rejected = expect(suspension).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
});

it("allows destroyed renderers to leave without holding teardown open", async () => {
  const lifecycle = registerRendererLibraryLifecycle();
  fixture.handlers.get("library:watch")!(event(), "before");
  fixture.listeners.delete("library:will-change");
  const suspension = lifecycle.suspend();
  fixture.sender.emit("destroyed");
  await suspension;
  expect(fixture.sender.listenerCount("destroyed")).toBe(0);
});

it("immediately suspends a newly registering preload while a library change is underway", async () => {
  const lifecycle = registerRendererLibraryLifecycle();
  await lifecycle.suspend();
  const stop = vi.fn(async () => {});
  await fixture.api.library.onWillChange(stop);
  expect(stop).toHaveBeenCalled();
  const reset = vi.fn();
  fixture.api.library.onDidChange(reset);
  lifecycle.reset();
  expect(reset).toHaveBeenCalledOnce();
});

it("refuses replacement if a new preload takes over the same WebContents during drain", async () => {
  const lifecycle = registerRendererLibraryLifecycle();
  const held = deferred();
  await fixture.api.library.onWillChange(() => held.promise);
  const oldApi = fixture.api;
  const change = lifecycle.suspend();
  const refused = expect(change).rejects.toThrow("Renderer document changed");
  const [, nonce, oldDocument] = fixture.sender.send.mock.calls.at(-1)!;

  vi.resetModules();
  await import("../../preload/preload.js");
  expect(fixture.api).not.toBe(oldApi);
  const stop = vi.fn(async () => {});
  const reset = vi.fn();
  fixture.api.library.onDidChange(reset);
  await fixture.api.library.onWillChange(stop);
  await refused;
  expect(stop).toHaveBeenCalled();
  fixture.handlers.get("library:drained")!(event(), nonce, false, oldDocument);
  held.resolve();
  await flush();
  expect(reset).not.toHaveBeenCalled();
});

it("does not reset a renderer after database opening or settings persistence fails", async () => {
  for (const failingStage of ["open", "settings"]) {
    const fail = async () => {
      throw new Error(failingStage);
    };
    registerLibraryHandlers({
      settings: {
        assertWritable: async () => {},
        setLibraryRoot: failingStage === "settings" ? fail : async () => {}
      },
      databaseManager: {
        open: failingStage === "open" ? fail : async () => {}
      },
      repository: {}
    } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
    const stop = vi.fn(async () => {});
    await fixture.api.library.onWillChange(stop);
    const reset = vi.fn();
    fixture.api.library.onDidChange(reset);
    await expect(fixture.api.library.choose()).rejects.toThrow(failingStage);
    expect(stop).toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  }
});
