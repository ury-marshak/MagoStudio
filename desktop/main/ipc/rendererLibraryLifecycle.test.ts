import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
  cancelled: false
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
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
    })
  },
  shell: {}
}));

import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { projects } from "../database/schema";

import { registerLibraryHandlers } from "./registerLibraryHandlers";
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
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
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

it("requires both the trusted sender and its exact nonce before acknowledging a drain", async () => {
  const lifecycle = registerRendererLibraryLifecycle();
  const watch = fixture.handlers.get("library:watch")!;
  const ack = fixture.handlers.get("library:drained")!;
  expect(() => watch(event(fixture.sender, "https://evil.invalid"))).toThrow(
    "untrusted"
  );
  watch(event());
  const drain = deferred();
  await fixture.api.library.onWillChange(() => drain.promise);
  let finished = false;
  const suspension = lifecycle.suspend().then(() => {
    finished = true;
  });
  const nonce = fixture.sender.send.mock.calls.at(-1)![1];
  ack(event(), "wrong", false);
  ack(event({}), nonce, false);
  expect(() =>
    ack(event(fixture.sender, "https://evil.invalid"), nonce, false)
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
  fixture.handlers.get("library:watch")!(event());
  fixture.listeners.delete("library:will-change");
  const suspension = lifecycle.suspend();
  const rejected = expect(suspension).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
});

it("allows destroyed renderers to leave without holding teardown open", async () => {
  const lifecycle = registerRendererLibraryLifecycle();
  fixture.handlers.get("library:watch")!(event());
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
