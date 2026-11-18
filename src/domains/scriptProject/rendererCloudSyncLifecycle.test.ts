/* oxlint-disable local/no-cross-domain-internal-imports -- the composed fixture exercises the real renderer mutation APIs without mounting pages */

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  IPC_CHANNELS,
  type MagoDesktopApi
} from "../../../desktop/shared/contracts";

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  sender: null as any,
  api: null as unknown as MagoDesktopApi,
  folder: "",
  calls: [] as string[],
  backend: vi.fn(),
  mutation: vi.fn()
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) =>
      fixture.handlers.set(name, handler)
  },
  ipcRenderer: {
    invoke: async (name: string, ...args: unknown[]) => {
      fixture.calls.push(name);
      return fixture.handlers.get(name)!(
        {
          sender: fixture.sender,
          senderFrame: { url: "http://localhost:3000/" }
        },
        ...args
      );
    },
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
  getLocalDesktopApi: () => fixture.api
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: {
    get: fixture.backend,
    put: fixture.mutation,
    post: fixture.mutation,
    delete: fixture.mutation
  }
}));

import { CloudProjectMirrorRepository } from "../../../desktop/main/database/cloudProjectMirrorRepository";
import { DatabaseManager } from "../../../desktop/main/database/databaseManager";
import { ProjectRepository } from "../../../desktop/main/database/projectRepository";
import {
  projects,
  scriptProjectSnapshots,
  shots,
  tracks
} from "../../../desktop/main/database/schema";
import { ScriptProjectSnapshotRepository } from "../../../desktop/main/database/scriptProjectSnapshotRepository";
import { registerLibraryHandlers } from "../../../desktop/main/ipc/registerLibraryHandlers";
import { registerProjectHandlers } from "../../../desktop/main/ipc/registerProjectHandlers";
import type { LibrarySettings } from "../../../desktop/main/librarySettings";

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
  fixture.calls.length = 0;
  fixture.backend.mockReset();
  fixture.mutation.mockReset();
  fixture.sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn((channel: string, ...args: unknown[]) =>
      fixture.listeners.get(channel)?.({}, ...args)
    )
  });
  await import("../../../desktop/preload/preload.js");
  fixture.api.account.mode = "cloud";
  vi.stubGlobal("window", { mago: fixture.api });
});
afterEach(async () => {
  const { rendererLibrary } = await import("@/platform/rendererLibraryWork");
  await rendererLibrary.suspend();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setupLibraries = async (
  type: "timeline" | "script_to_shots" = "timeline"
) => {
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
        settingsJson: JSON.stringify({ origin: "cloud", type }),
        createdAt: new Date(),
        updatedAt: new Date()
      });
    await manager.get().insert(shots).values({
      id: "same-shot",
      projectId: "reused",
      name: library,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await manager.get().insert(tracks).values({
      id: "same-track",
      projectId: "reused",
      shotId: "same-shot",
      type: "render",
      name: library,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  await manager.open(roots[0]);
  fixture.folder = roots[1];
  let rootPath = roots[0];
  const getLibraryRoot = async () => rootPath;
  const setLibraryRoot = vi.fn(async (value: string) => {
    rootPath = value;
  });
  const getAppMode = vi.fn(async () => "cloud");
  const settings = {
    getLibraryRoot,
    setLibraryRoot,
    getAppMode,
    assertWritable: async () => {}
  } as unknown as LibrarySettings;
  const projectRepository = new ProjectRepository(manager, getLibraryRoot);
  const storage = {
    allowedHosts: ["fixture.invalid"],
    fetchFromCloudStorage: vi.fn(async () => {
      throw new Error("Unexpected storage request");
    })
  };
  const mirror = new CloudProjectMirrorRepository(
    manager,
    getLibraryRoot,
    storage
  );
  const snapshots = new ScriptProjectSnapshotRepository(
    manager,
    getLibraryRoot,
    storage
  );
  // Use the desktop ES2022 modules without pulling them into renderer ES2017 type checking.
  const serviceModule =
    "../../../desktop/main/scriptProjects/localScriptProjectService.ts";
  const handlerModule =
    "../../../desktop/main/ipc/registerScriptProjectHandlers.ts";
  const { LocalScriptProjectService } = await import(serviceModule);
  const { registerScriptProjectHandlers } = await import(handlerModule);
  const service = new LocalScriptProjectService(
    projectRepository,
    snapshots,
    async () => {
      throw new Error("Unexpected Comfy request");
    }
  );
  registerProjectHandlers(projectRepository, mirror, manager, settings);
  registerScriptProjectHandlers({
    service,
    chat: {},
    databaseManager: manager,
    settings
  });
  const beforeLibraryChange = vi.fn(async () => {
    await Promise.all([
      mirror.libraryWork.suspend(),
      snapshots.libraryWork.suspend(),
      service.suspendPlans()
    ]);
  });
  registerLibraryHandlers({
    settings,
    databaseManager: manager,
    repository: projectRepository,
    beforeLibraryChange,
    afterLibraryChange: () => {
      mirror.libraryWork.reset();
      snapshots.libraryWork.reset();
      service.resetPlans();
    }
  });
  return {
    manager,
    roots,
    mirror,
    snapshots,
    projectRepository,
    beforeLibraryChange,
    setLibraryRoot,
    getAppMode
  };
};

const remoteProject = (type: "timeline" | "script_to_shots" = "timeline") => ({
  id: "reused",
  name: "old remote update",
  description: "",
  active: true,
  type,
  settings: { visual_style: "Ink" }
});

it.each(["backend", "issued-mirror", "issued-mirror-account"] as const)(
  "owns cloud-sync %s work through real preload acknowledgement and two reused-ID SQLite libraries",
  async (stage) => {
    const { manager, roots, mirror, beforeLibraryChange, getAppMode } =
      await setupLibraries();
    const held = deferred();
    getAppMode.mockImplementationOnce(async () => {
      if (stage === "issued-mirror-account") await held.promise;
      return "cloud";
    });
    fixture.backend.mockImplementation(async () => {
      if (stage === "backend") await held.promise;
      return { data: remoteProject() };
    });
    const mirrorPut = mirror.put.bind(mirror);
    const write = vi.spyOn(mirror, "put").mockImplementation(async (input) => {
      if (stage === "issued-mirror") await held.promise;
      return mirrorPut(input);
    });
    const { syncCloudProjectMetadata } =
      await import("./syncCloudScriptProjects.local");
    const sync = syncCloudProjectMetadata("reused");
    const rejected = expect(sync).rejects.toMatchObject({ name: "AbortError" });
    const awaited = {
      backend: fixture.backend,
      "issued-mirror": write,
      "issued-mirror-account": getAppMode
    }[stage];
    await vi.waitFor(() => expect(awaited).toHaveBeenCalledOnce());
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
      expect(beforeLibraryChange).not.toHaveBeenCalled();
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
    expect(write).toHaveBeenCalledTimes(stage === "backend" ? 0 : 1);
  }
);

const rename = {
  projectId: "reused",
  projectName: "old remote update",
  projectDescription: "",
  settingsPatch: { visual_style: "Ink" }
};

it.each(["script_to_shots", "timeline"] as const)(
  "drops a late %s rename/settings response before issuing snapshot or mirror IPC against reused IDs",
  async (type) => {
    const { roots, projectRepository } = await setupLibraries(type);
    const held = deferred();
    fixture.backend.mockResolvedValue({ data: remoteProject(type) });
    fixture.mutation.mockImplementation(async () => {
      await held.promise;
      return { data: remoteProject(type) };
    });
    const { updateProject } =
      await import("@domains/project/api/updateProject");
    const pending = updateProject(rename).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fixture.mutation).toHaveBeenCalledOnce());
    await fixture.api.library.choose();
    const issued = fixture.calls.slice();
    held.resolve();
    const result = await pending;
    expect(fixture.calls).toEqual(issued);
    expect(fixture.backend).toHaveBeenCalledOnce();
    expect(fixture.calls).not.toContain(IPC_CHANNELS.scriptProjectsPut);
    expect(fixture.calls).not.toContain(IPC_CHANNELS.projectsMirrorCloud);
    expect(result).toMatchObject({ name: "AbortError" });
    expect(await projectRepository.get("reused")).toMatchObject({
      name: roots[1]
    });

    const replacement = { ...remoteProject(type), name: "Replacement rename" };
    fixture.backend.mockResolvedValue({ data: replacement });
    fixture.mutation.mockResolvedValue({ data: replacement });
    await updateProject({ ...rename, projectName: replacement.name });
    expect(await projectRepository.get("reused")).toMatchObject({
      name: replacement.name
    });
  }
);

const projectInput = {
  projectName: "Old create",
  projectDescription: "",
  rangeMin: 0,
  rangeMax: 48,
  creationTarget: "cloud" as const
};

const shotInput = {
  name: "Old shot rename",
  settings: {},
  project_id: "reused"
};
const trackInput = {
  layerId: "same-track",
  layerName: "Old track rename",
  layerData: {},
  projectId: "reused"
};

const actions = {
  "create script project": async () => {
    const { createProject } =
      await import("@domains/project/useCreateProject.local");
    return createProject({ ...projectInput, projectType: "script_to_shots" });
  },
  "create timeline project": async () => {
    const { createProject } =
      await import("@domains/project/useCreateProject.local");
    return createProject(projectInput);
  },
  "create shot": async () => {
    const { postTimeline } = await import("@domains/shot/postTimeline");
    return postTimeline("reused", "Old new shot");
  },
  "rename shot": async () => {
    const { putTimeline } = await import("@domains/shot/putTimeline");
    return putTimeline("same-shot", shotInput);
  },
  "delete shot": async () => {
    const { deleteTimeline } = await import("@domains/shot/deleteTimeline");
    return deleteTimeline("same-shot", "reused");
  },
  "create track": async () => {
    const { postTrack } = await import("@domains/track/api/postLayer");
    const { LayerType } = await import("@schemas/layer");
    return postTrack(
      {
        shotId: "same-shot",
        trackName: "Old new track",
        trackType: LayerType.RENDER,
        data: {},
        parentTrackOrder: 1
      },
      "reused"
    );
  },
  "rename track": async () => {
    const { putTrack } = await import("@domains/track/api/putTrack");
    return putTrack(trackInput);
  },
  "delete track": async () => {
    const { deleteTrack } = await import("@domains/track/api/deleteTrack");
    return deleteTrack({ trackId: "same-track", projectId: "reused" });
  }
};

it.each(Object.entries(actions))(
  "drops the old %s result rather than returning it or syncing the replacement",
  async (label, start) => {
    const type =
      label === "create script project" ? "script_to_shots" : "timeline";
    const { manager, roots } = await setupLibraries(type);
    const held = deferred();
    fixture.backend.mockResolvedValue({ data: remoteProject(type) });
    fixture.mutation.mockImplementation(async () => {
      await held.promise;
      return {
        data: {
          ...remoteProject(type),
          id: label.includes("track") ? "same-track" : "reused"
        }
      };
    });
    const pending = start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fixture.mutation).toHaveBeenCalledOnce());
    await fixture.api.library.choose();
    const issued = fixture.calls.slice();
    held.resolve();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(fixture.calls).toEqual(issued);
    expect(fixture.backend).not.toHaveBeenCalled();
    expect(await manager.get().select().from(scriptProjectSnapshots)).toEqual(
      []
    );
    for (const table of [projects, shots, tracks]) {
      expect(await manager.get().select().from(table)).toEqual([
        expect.objectContaining({ name: roots[1], active: true })
      ]);
    }
  }
);

it("drains an issued lookup but cannot use its old routing result for a new PUT", async () => {
  const { roots, manager, projectRepository, beforeLibraryChange } =
    await setupLibraries();
  const held = deferred();
  const read = projectRepository.get.bind(projectRepository);
  const lookup = vi
    .spyOn(projectRepository, "get")
    .mockImplementationOnce(async (id) => {
      const project = await read(id);
      await held.promise;
      return project;
    });
  const { updateProject } = await import("@domains/project/api/updateProject");
  const pending = updateProject(rename).catch((error: unknown) => error);
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
  const change = fixture.api.library.choose();
  await flush();
  expect(beforeLibraryChange).not.toHaveBeenCalled();
  held.resolve();
  await change;
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(fixture.backend).not.toHaveBeenCalled();
  expect(fixture.mutation).not.toHaveBeenCalled();
  expect(await manager.get().select().from(projects)).toEqual([
    expect.objectContaining({ name: roots[1] })
  ]);
});

it("does not send a rename PUT after a delayed settings GET", async () => {
  await setupLibraries();
  const held = deferred();
  fixture.backend.mockImplementation(async () => {
    await held.promise;
    return { data: remoteProject() };
  });
  const { updateProject } = await import("@domains/project/api/updateProject");
  const pending = updateProject(rename).catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.backend).toHaveBeenCalledOnce());
  await fixture.api.library.choose();
  held.resolve();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(fixture.mutation).not.toHaveBeenCalled();
  expect(fixture.calls).not.toContain(IPC_CHANNELS.projectsMirrorCloud);
});

it("drains an issued snapshot write before main suspends and never issues the post-write read", async () => {
  const { roots, manager, snapshots, beforeLibraryChange } =
    await setupLibraries("script_to_shots");
  const held = deferred();
  const put = snapshots.put.bind(snapshots);
  const write = vi
    .spyOn(snapshots, "put")
    .mockImplementationOnce(async (input) => {
      await held.promise;
      await put(input);
    });
  fixture.backend.mockResolvedValue({ data: remoteProject("script_to_shots") });
  fixture.mutation.mockResolvedValue({
    data: remoteProject("script_to_shots")
  });
  const { updateProject } = await import("@domains/project/api/updateProject");
  const pending = updateProject(rename).catch((error: unknown) => error);
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  const change = fixture.api.library.choose();
  await flush();
  expect(beforeLibraryChange).not.toHaveBeenCalled();
  held.resolve();
  await change;
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(fixture.calls).not.toContain(IPC_CHANNELS.scriptProjectsGet);
  expect(await manager.get().select().from(projects)).toEqual([
    expect.objectContaining({ name: roots[1] })
  ]);
  await manager.open(roots[0]);
  expect(await manager.get().select().from(projects)).toEqual([
    expect.objectContaining({ name: "old remote update" })
  ]);
});

it.each(["opening", "settings"] as const)(
  "refuses new mutations during and after failed library %s",
  async (stage) => {
    const { manager, setLibraryRoot } = await setupLibraries();
    const held = deferred();
    const fail = async () => {
      await held.promise;
      throw new Error(`Failed ${stage}`);
    };
    const blocked =
      stage === "opening"
        ? vi.spyOn(manager, "open").mockImplementationOnce(fail)
        : setLibraryRoot.mockImplementationOnce(fail);
    const { rendererLibrary } = await import("@/platform/rendererLibraryWork");
    await rendererLibrary.capture().ready();
    const choosing = fixture.api.library
      .choose()
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
    const issued = fixture.calls.slice();
    const { updateProject } =
      await import("@domains/project/api/updateProject");
    await expect(updateProject(rename)).rejects.toMatchObject({
      name: "AbortError"
    });
    held.resolve();
    expect(await choosing).toMatchObject({ message: `Failed ${stage}` });
    for (const start of Object.values(actions)) {
      await expect(start()).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(fixture.calls).toEqual(issued);
    expect(fixture.backend).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
  }
);
