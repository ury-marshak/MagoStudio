import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MagoDesktopApi } from "../../../desktop/shared/contracts";

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  sender: null as any,
  api: null as unknown as MagoDesktopApi,
  folder: "",
  backend: vi.fn()
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
      canceled: false,
      filePaths: [fixture.folder]
    })
  },
  shell: {}
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => ({ ...fixture.api, account: { mode: "cloud" } })
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get: fixture.backend }
}));

import { CloudProjectMirrorRepository } from "../../../desktop/main/database/cloudProjectMirrorRepository";
import { DatabaseManager } from "../../../desktop/main/database/databaseManager";
import { ProjectRepository } from "../../../desktop/main/database/projectRepository";
import { projects } from "../../../desktop/main/database/schema";
import { registerLibraryHandlers } from "../../../desktop/main/ipc/registerLibraryHandlers";

const directories: string[] = [];
const managers: DatabaseManager[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

beforeEach(async () => {
  vi.resetModules();
  fixture.handlers.clear();
  fixture.listeners.clear();
  fixture.backend.mockReset();
  fixture.sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn((channel: string, ...args: unknown[]) =>
      fixture.listeners.get(channel)?.({}, ...args)
    )
  });
  await import("../../../desktop/preload/preload.js");
});
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

it.each(["backend", "issued-mirror"] as const)(
  "owns cloud-sync %s work through real preload acknowledgement and two reused-ID SQLite libraries",
  async (stage) => {
    const root = await mkdtemp(
      path.join(tmpdir(), "mago-cloud-producer-libraries-")
    );
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
          settingsJson: JSON.stringify({ origin: "cloud" }),
          createdAt: new Date(),
          updatedAt: new Date()
        });
    }
    await manager.open(roots[0]);
    fixture.folder = roots[1];
    let rootPath = roots[0];
    const repository = new CloudProjectMirrorRepository(
      manager,
      async () => rootPath
    );
    registerLibraryHandlers({
      settings: {
        assertWritable: async () => {},
        setLibraryRoot: async (value: string) => {
          rootPath = value;
        }
      },
      databaseManager: manager,
      repository: new ProjectRepository(manager, async () => rootPath)
    } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
    const held = deferred();
    const remoteProject = {
      id: "reused",
      name: "old remote update",
      description: "",
      active: true,
      type: "timeline",
      settings: {}
    };
    fixture.backend.mockImplementation(async () => {
      if (stage === "backend") await held.promise;
      return { data: remoteProject };
    });
    // Fixture route: production mirror routes still need independent main-process
    // ownership. Here the renderer must drain the complete issued repository IPC.
    const mirror = vi.fn(
      async (_event: unknown, input: Parameters<typeof repository.put>[0]) => {
        await held.promise;
        return repository.put(input);
      }
    );
    fixture.handlers.set("projects:mirror-cloud", mirror);
    const { rendererLibrary } = await import("@/platform/rendererLibraryWork");
    const { syncCloudProjectMetadata } =
      await import("./syncCloudScriptProjects.local");
    const sync = syncCloudProjectMetadata("reused");
    const rejected = expect(sync).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() =>
      expect(
        stage === "backend" ? fixture.backend : mirror
      ).toHaveBeenCalledOnce()
    );
    let changed = false;
    const change = fixture.api.library.choose().then(() => {
      changed = true;
    });
    await flush();
    if (stage === "backend") {
      await change;
      held.resolve();
    } else {
      expect(changed).toBe(false);
      expect((await manager.get().select().from(projects))[0].name).toBe(
        roots[0]
      );
      held.resolve();
      await change;
    }
    await rejected;
    expect((await manager.get().select().from(projects))[0].name).toBe(
      roots[1]
    );
    await manager.open(roots[0]);
    expect((await manager.get().select().from(projects))[0].name).toBe(
      stage === "backend" ? roots[0] : "old remote update"
    );
    expect(mirror).toHaveBeenCalledTimes(stage === "backend" ? 0 : 1);
    await rendererLibrary.suspend();
  }
);
