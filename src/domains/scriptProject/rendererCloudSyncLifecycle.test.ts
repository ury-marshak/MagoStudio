/* oxlint-disable local/no-cross-domain-internal-imports -- the composed fixture exercises the real renderer mutation APIs without mounting pages */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

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
  mutation: vi.fn(),
  putObject: vi.fn()
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
      fixture.listeners.set(name, listener),
    removeListener: (name: string, listener: (...args: any[]) => any) => {
      if (fixture.listeners.get(name) === listener)
        fixture.listeners.delete(name);
    }
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
vi.mock("node:https", async (original) => {
  const https = await original<typeof import("node:https")>();
  return {
    ...https,
    request: fixture.putObject,
    default: { ...https, request: fixture.putObject }
  };
});
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
  assets,
  clips,
  cloudRenderJobs,
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
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
  fixture.putObject.mockReset().mockImplementation(() => {
    throw new Error("Unexpected PUT");
  });
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
  type: "timeline" | "script_to_shots" = "timeline",
  origin: "local" | "cloud" = "cloud"
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
        settingsJson: JSON.stringify({ origin, type }),
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
    const sourcePath = path.join(library, "source.mp4");
    await writeFile(sourcePath, library);
    await manager.get().insert(assets).values({
      id: "same-asset",
      name: library,
      type: "video",
      sourcePath,
      status: "available",
      width: 640,
      height: 480,
      frameCount: 100
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
    fetchFromCloudStorage: vi.fn(async (): Promise<Response> => {
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
  const cloudLinkModule = "../../../desktop/main/cloud/cloudLinkRepository.ts";
  const jobModule = "../../../desktop/main/cloud/cloudRenderJobRepository.ts";
  const uploadModule = "../../../desktop/main/cloud/uploadService.ts";
  const submitModule =
    "../../../desktop/main/cloud/cloudRenderSubmitService.ts";
  const cloudHandlerModule =
    "../../../desktop/main/ipc/registerCloudHandlers.ts";
  const [
    { CloudLinkRepository },
    { CloudRenderJobRepository },
    { UploadService },
    { CloudRenderSubmitService },
    { registerCloudHandlers }
  ] = await Promise.all([
    import(cloudLinkModule),
    import(jobModule),
    import(uploadModule),
    import(submitModule),
    import(cloudHandlerModule)
  ]);
  const links = new CloudLinkRepository(manager);
  const renderJobs = new CloudRenderJobRepository(manager);
  const uploads = new UploadService(getLibraryRoot);
  const renderSubmits = new CloudRenderSubmitService(manager, getLibraryRoot);
  registerCloudHandlers({
    links,
    renderJobs,
    uploads,
    renderSubmits,
    repository: projectRepository,
    databaseManager: manager,
    getLibraryRoot,
    settings
  });
  const cloudOwners = [
    links.libraryWork,
    renderJobs.libraryWork,
    uploads.libraryWork,
    renderSubmits.libraryWork
  ];
  const beforeLibraryChange = vi.fn(async () => {
    await Promise.all([
      mirror.libraryWork.suspend(),
      snapshots.libraryWork.suspend(),
      service.suspendPlans(),
      ...cloudOwners.map((owner) => owner.suspend())
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
      for (const owner of cloudOwners) owner.reset();
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
    getAppMode,
    links,
    storage
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
    await expect(startRender("video")).rejects.toMatchObject({
      name: "AbortError"
    });
    held.resolve();
    expect(await choosing).toMatchObject({ message: `Failed ${stage}` });
    for (const start of [
      ...Object.values(actions),
      () => startRender("video"),
      () => startRender("image"),
      () => startRender("i2v"),
      async () => {
        const { adaptCloudI2vPromptFromLocal } =
          await import("@domains/prompt/api/adaptCloudI2vPromptFromLocal");
        const { VideoEngine } = await import("@models/video/types");
        return adaptCloudI2vPromptFromLocal(
          {
            prompt: "original",
            referenceImageAssetIds: [],
            cloudEngine: VideoEngine.minimax_reference
          },
          rendererLibrary.capture()
        );
      },
      async () => {
        const { resumePlan } =
          await import("@domains/plan/api/resumePlan.local");
        return resumePlan("same-plan", rendererLibrary.capture());
      }
    ]) {
      await expect(start()).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(fixture.calls).toEqual(issued);
    expect(fixture.backend).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
  }
);

const reusedLocal = {
  projectId: "reused",
  projectName: "Project",
  shotId: "same-shot",
  shotName: "Shot",
  assetId: "same-asset",
  assetName: "Source",
  outputTrackId: "same-track"
};

const rememberRenderInputs = async () => {
  for (const [kind, localId, cloudId] of [
    ["project", "reused", "cloud-project"],
    ["timeline", "same-shot", "cloud-shot"],
    ["asset", "same-asset", "cloud-source"]
  ] as const) {
    await fixture.api.cloud.links.put({
      kind,
      localId,
      cloudId,
      data: { origin: "cloud", cloudLayerId: "cloud-layer" }
    });
  }
};

const startRender = async (
  kind: "video" | "image" | "i2v",
  onProgress = vi.fn()
) => {
  const { backendCloudApi } = await import("@domains/cloud/backendCloudApi");
  const payload = {
    parent_layer_id: "same-track",
    frame_range: [0, 24],
    render_mode: "credits",
    render_settings: { magov2: { image_id: "same-asset" } },
    sources: {},
    render_engine: "magov2"
  };
  const input = {
    payload,
    local: reusedLocal,
    model: "fixture-model",
    fps: 24,
    frameRange: [0, 24] as [number, number],
    onProgress
  };
  if (kind === "i2v") {
    const { submitCloudImageToVideoRender } =
      await import("@domains/cloud/submitCloudImageToVideoRender");
    return submitCloudImageToVideoRender(backendCloudApi(), input);
  }
  if (kind === "image") {
    const { submitCloudImg2ImgRender } =
      await import("@domains/cloud/submitCloudImg2ImgRender");
    return submitCloudImg2ImgRender(backendCloudApi(), {
      payload: {
        settings: {},
        frame: 0,
        img_file_type: "jpg",
        render_mode: "credits",
        render_model: input.model
      },
      local: reusedLocal,
      onProgress
    });
  }
  const { submitCloudRender } =
    await import("@domains/cloud/submitCloudRender");
  return submitCloudRender(backendCloudApi(), input);
};

const accepted = (id: string) => ({
  data: { clips: [{ id: `clip-${id}`, asset: { id } }] }
});

it.each(["video", "image", "i2v"] as const)(
  "never registers, deletes or repeats a late accepted %s render after replacing its library",
  async (kind) => {
    const { manager, roots } = await setupLibraries("timeline", "local");
    await rememberRenderInputs();
    const entered = deferred<AbortSignal>();
    const response = deferred<ReturnType<typeof accepted>>();
    const endpoint =
      kind === "image" ? "/assets/img2img/render" : "/assets/add_render";
    fixture.backend.mockResolvedValue({ data: { layer_order: 1 } });
    fixture.mutation.mockImplementation(async (url, _body, config) => {
      if (url === "/layers") return { data: { id: "output-layer" } };
      if (url !== endpoint) throw new Error(`Unexpected mutation ${url}`);
      if (
        fixture.mutation.mock.calls.filter(([path]) => path === endpoint)
          .length === 1
      ) {
        entered.resolve(config.signal);
        return response.promise;
      }
      return accepted("replacement-job");
    });
    const onProgress = vi.fn();
    const old = startRender(kind, onProgress).catch((error: unknown) => error);
    const oldSignal = await entered.promise;
    await fixture.api.library.choose();
    expect(oldSignal.aborted).toBe(true);
    await rememberRenderInputs();
    await expect(startRender(kind)).resolves.toMatchObject({
      cloudAssetId: "replacement-job"
    });
    const ipcBefore = fixture.calls.slice();
    const progressBefore = onProgress.mock.calls.slice();
    response.resolve(accepted("old-job"));
    expect(await old).toMatchObject({ name: "AbortError" });
    expect(fixture.calls).toEqual(ipcBefore);
    expect(onProgress.mock.calls).toEqual(progressBefore);
    expect(fixture.mutation.mock.calls.map(([url]) => url)).toEqual(
      kind === "image"
        ? [endpoint, endpoint]
        : ["/layers", endpoint, "/layers", endpoint]
    );
    expect(await manager.get().select().from(cloudRenderJobs)).toEqual([
      expect.objectContaining({
        cloudAssetId: "replacement-job",
        projectId: "reused"
      })
    ]);
    await manager.open(roots[0]);
    expect(await manager.get().select().from(cloudRenderJobs)).toEqual([]);
  }
);

it("drains an issued render registration into the original database before acknowledgement", async () => {
  const { manager, roots, beforeLibraryChange } = await setupLibraries();
  await rememberRenderInputs();
  const entered = deferred();
  const release = deferred();
  const transaction = manager.transaction.bind(manager);
  vi.spyOn(manager, "transaction").mockImplementationOnce(async (run) => {
    entered.resolve();
    await release.promise;
    return transaction(run);
  });
  fixture.mutation.mockResolvedValue(accepted("issued-job"));
  const old = startRender("image").catch((error: unknown) => error);
  await entered.promise;
  const changing = fixture.api.library.choose();
  await flush();
  expect(beforeLibraryChange).not.toHaveBeenCalled();
  release.resolve();
  await changing;
  expect(await old).toMatchObject({ name: "AbortError" });
  expect(await manager.get().select().from(cloudRenderJobs)).toEqual([]);
  expect(fixture.mutation.mock.calls.map(([url]) => url)).toEqual([
    "/assets/img2img/render"
  ]);
  await manager.open(roots[0]);
  expect(await manager.get().select().from(cloudRenderJobs)).toEqual([
    expect.objectContaining({ cloudAssetId: "issued-job", projectId: "reused" })
  ]);
});

it("does not let an old project resolution or its finally retarget a reused ID", async () => {
  await setupLibraries();
  const { ensureCloudProject } = await import("@domains/cloud/mirrorService");
  const { backendCloudApi } = await import("@domains/cloud/backendCloudApi");
  const first = deferred<{ data: { id: string } }>();
  const second = deferred<{ data: { id: string } }>();
  fixture.mutation
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const resolve = () =>
    ensureCloudProject(backendCloudApi(), {
      localProjectId: "reused",
      name: "Same name"
    });
  const old = resolve().catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.mutation).toHaveBeenCalledTimes(1));
  await fixture.api.library.choose();
  const replacement = resolve();
  await vi.waitFor(() => expect(fixture.mutation).toHaveBeenCalledTimes(2));
  first.resolve({ data: { id: "old-cloud-id" } });
  const calls = fixture.calls.slice();
  expect(await old).toMatchObject({ name: "AbortError" });
  expect(fixture.calls).toEqual(calls);
  const coalesced = resolve();
  second.resolve({ data: { id: "replacement-cloud-id" } });
  expect(await Promise.all([replacement, coalesced])).toEqual([
    "replacement-cloud-id",
    "replacement-cloud-id"
  ]);
  expect(fixture.mutation).toHaveBeenCalledTimes(2);
  expect(await fixture.api.cloud.links.get("project", "reused")).toMatchObject({
    cloudId: "replacement-cloud-id"
  });
});

it("reconfirms a project and timeline linked to the same cloud IDs in the next library", async () => {
  await setupLibraries();
  const { ensureCloudProject, ensureCloudTimeline } =
    await import("@domains/cloud/mirrorService");
  const { backendCloudApi } = await import("@domains/cloud/backendCloudApi");
  const seedAndVerify = async () => {
    await fixture.api.cloud.links.put({
      kind: "project",
      localId: "reused",
      cloudId: "cloud-project"
    });
    await fixture.api.cloud.links.put({
      kind: "timeline",
      localId: "same-shot",
      cloudId: "cloud-shot"
    });
    await expect(
      ensureCloudProject(backendCloudApi(), {
        localProjectId: "reused",
        name: "Project"
      })
    ).resolves.toBe("cloud-project");
    await expect(
      ensureCloudTimeline(backendCloudApi(), {
        localShotId: "same-shot",
        cloudProjectId: "cloud-project",
        name: "Shot"
      })
    ).resolves.toBe("cloud-shot");
  };
  fixture.backend.mockResolvedValue({ data: { project_id: "cloud-project" } });
  await seedAndVerify();
  await fixture.api.library.choose();
  await seedAndVerify();
  expect(fixture.backend.mock.calls.map(([url]) => url)).toEqual([
    "/projects/cloud-project",
    "/timeline/cloud-shot",
    "/projects/cloud-project",
    "/timeline/cloud-shot"
  ]);
  expect(fixture.mutation).not.toHaveBeenCalled();
});

it("acknowledges while an old preparation is still in its account wait, then refuses its continuation", async () => {
  const { getAppMode } = await setupLibraries();
  const { ensureCloudAsset } = await import("@domains/cloud/mirrorService");
  const { backendCloudApi } = await import("@domains/cloud/backendCloudApi");
  const waiting = deferred();
  const late = deferred();
  getAppMode.mockImplementationOnce(async () => {
    waiting.resolve();
    await late.promise;
    return "cloud";
  });
  const progress = vi.fn();
  const pending = ensureCloudAsset(backendCloudApi(), {
    localAssetId: "same-asset",
    localShotId: "same-shot",
    cloudTimelineId: "cloud-shot",
    name: "Source",
    onProgress: progress
  }).catch((error: unknown) => error);
  await waiting.promise;
  await fixture.api.library.choose();
  const ipcBefore = fixture.calls.slice();
  late.resolve();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(fixture.calls).toEqual(ipcBefore);
  expect(progress.mock.calls).toEqual([["encoding"]]);
  expect(fixture.mutation).not.toHaveBeenCalled();
  expect(fixture.putObject).not.toHaveBeenCalled();
});

const queuedPut = () => {
  const sent = deferred<string>();
  const closing = deferred();
  const release = deferred();
  const chunks: Buffer[] = [];
  const body = Object.assign(
    new Readable({
      read() {},
      destroy(error, callback) {
        closing.resolve();
        void release.promise.then(() => callback(error));
      }
    }),
    { statusCode: 200 }
  );
  fixture.putObject.mockImplementationOnce(
    (_url, _options, onResponse) =>
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          onResponse(body);
          sent.resolve(Buffer.concat(chunks).toString());
          callback();
        }
      })
  );
  return {
    sent: sent.promise,
    closing: closing.promise,
    release: release.resolve
  };
};

it.each(["file read", "trim body", "video body"] as const)(
  "does not advance video ingestion across the switch during %s",
  async (stage) => {
    const { manager, beforeLibraryChange } = await setupLibraries();
    const { ingestVideo } = await import("@domains/videoUpload/ingestVideo");
    const { uploadAssetToS3 } = await import("@domains/asset/api/putAssetOnS3");
    const file = new File(["library-a-bytes"], "fixture.mp4", {
      type: "video/mp4"
    });
    const read = deferred();
    const bytes = deferred<ArrayBuffer>();
    const put = stage === "file read" ? null : queuedPut();
    if (!put) {
      vi.spyOn(file, "arrayBuffer").mockImplementationOnce(() => {
        read.resolve();
        return bytes.promise;
      });
    }
    const publish = vi.fn();
    const cache = vi.fn();
    const invalidate = vi.fn();
    const progress = vi.fn();
    const uploaded = vi.fn();
    const pending = ingestVideo(
      {
        projectId: "reused",
        shotId: "same-shot",
        file,
        onProgress: progress,
        onUploaded: uploaded,
        ...(stage === "trim body"
          ? { trimMetadata: { trimStart: 1, trimEnd: 2 } }
          : {})
      },
      {
        createVideoAsset: async () =>
          ({
            video_url: "https://upload.invalid/video",
            meta_url: "https://upload.invalid/trim",
            timeline: {
              layers: [
                {
                  id: "same-track",
                  name: "Source",
                  type: "IMAGE",
                  created_at: "2026-01-01",
                  clips: [{ asset: { id: "same-asset" } }]
                }
              ]
            }
          }) as never,
        uploadAssetToS3,
        publishIngestionJob: publish,
        fetchVideoAssetStatus: vi.fn(),
        cacheVideoFile: cache,
        invalidateAfterIngest: invalidate,
        waitForPollTick: vi.fn()
      }
    );
    if (put) {
      const sent = await put.sent;
      if (stage === "video body") expect(sent).toBe("library-a-bytes");
      else
        expect(JSON.parse(sent)).toEqual({
          "trim-start": 1000,
          "trim-end": 2000
        });
    } else {
      await read.promise;
    }
    const opened = vi.spyOn(manager, "open");
    const choosing = fixture.api.library.choose();
    if (put) {
      await put.closing;
      await vi.waitFor(() =>
        expect(beforeLibraryChange).toHaveBeenCalledOnce()
      );
      expect(opened).not.toHaveBeenCalled();
      expect(
        fixture.calls.filter(
          (call) => call === IPC_CHANNELS.cloudCancelUploadBytes
        )
      ).toHaveLength(1);
      put.release();
    }
    await choosing;
    const calls = fixture.calls.slice();
    const progressBefore = progress.mock.calls.slice();
    bytes.resolve(new ArrayBuffer(12));
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
    expect(fixture.calls).toEqual(calls);
    expect(fixture.putObject).toHaveBeenCalledTimes(put ? 1 : 0);
    for (const call of [publish, cache, invalidate, uploaded])
      expect(call).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual(progressBefore);
    expect(fixture.listeners.has(IPC_CHANNELS.cloudUploadProgress)).toBe(false);
  }
);

it("acknowledges renderer teardown before main drains an issued mirror upload body", async () => {
  const { manager, roots, beforeLibraryChange } = await setupLibraries();
  const encodeModule = "../../../desktop/main/cloud/uploadEncode.ts";
  const { uploadCachePath } = await import(encodeModule);
  const encoded = path.join(
    roots[0],
    uploadCachePath({ assetId: "same-asset" })
  );
  await mkdir(path.dirname(encoded), { recursive: true });
  await writeFile(encoded, "old encoded source");
  const put = queuedPut();
  fixture.mutation.mockResolvedValue({
    data: {
      video_url: "https://upload.invalid/video",
      timeline: {
        layers: [
          { id: "source-layer", clips: [{ asset: { id: "old-cloud-source" } }] }
        ]
      }
    }
  });
  const { backendCloudApi } = await import("@domains/cloud/backendCloudApi");
  const { ensureCloudAsset } = await import("@domains/cloud/mirrorService");
  const progress = vi.fn();
  const pending = ensureCloudAsset(backendCloudApi(), {
    localAssetId: "same-asset",
    localShotId: "same-shot",
    cloudTimelineId: "cloud-shot",
    name: "Source",
    onProgress: progress
  }).catch((error: unknown) => error);
  await expect(put.sent).resolves.toBe("old encoded source");
  const opened = vi.spyOn(manager, "open");
  const choosing = fixture.api.library.choose();
  await put.closing;
  expect(beforeLibraryChange).toHaveBeenCalledOnce();
  expect(opened).not.toHaveBeenCalled();
  put.release();
  await choosing;
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(fixture.calls).not.toContain(IPC_CHANNELS.cloudCancelUploadBytes);
  expect(fixture.calls).not.toContain(IPC_CHANNELS.cloudLinkPatch);
  expect(fixture.mutation.mock.calls.map(([url]) => url)).toEqual([
    "/assets/video/upload"
  ]);
  expect(progress.mock.calls).toEqual([["encoding"], ["uploading"]]);
});

const installPromptReadiness = async (
  hasExternalText: () => Promise<boolean>
) => {
  const handlersPath = "../../../desktop/main/ipc/registerVlmHandlers.ts";
  const { registerVlmHandlers } = await import(handlersPath);
  registerVlmHandlers({}, {}, hasExternalText);
};

const missingSourceCloudId = "11111111-1111-1111-1111-111111111111";
const sourceLinkId = "same-asset#shot-same-shot#trim-full";
const seedPromptSource = async (manager: DatabaseManager) => {
  await manager.get().insert(clips).values({
    id: "same-clip",
    trackId: "same-track",
    assetId: "same-asset",
    name: "Camera footage"
  });
  await fixture.api.cloud.links.put({
    kind: "project",
    localId: "reused",
    cloudId: "cloud-project"
  });
  await fixture.api.cloud.links.put({
    kind: "timeline",
    localId: "same-shot",
    cloudId: "cloud-shot"
  });
  await fixture.api.cloud.links.put({
    kind: "asset",
    localId: sourceLinkId,
    cloudId: missingSourceCloudId,
    data: { cloudTimelineId: "cloud-shot", status: "ingested" }
  });
};

it.each(["readiness", "missing reference", "issued stale write"] as const)(
  "keeps prompt source context and stale-link retry in the old library during %s",
  async (stage) => {
    const { manager, roots, links, beforeLibraryChange } =
      await setupLibraries();
    await seedPromptSource(manager);
    await manager.open(roots[1]);
    await seedPromptSource(manager);
    await manager.open(roots[0]);
    const ready = deferred<boolean>();
    const adaptation = deferred<never>();
    const patchIssued = deferred();
    const continuePatch = deferred();
    const readiness = vi.fn(() =>
      stage === "readiness" ? ready.promise : Promise.resolve(false)
    );
    await installPromptReadiness(readiness);
    fixture.backend.mockResolvedValue({
      data: { project_id: "cloud-project" }
    });
    const missing = new Error(
      `reference asset ${missingSourceCloudId} not found`
    );
    fixture.mutation.mockImplementationOnce(() =>
      stage === "issued stale write"
        ? Promise.reject(missing)
        : adaptation.promise
    );
    if (stage === "issued stale write") {
      const patch = links.patchData.bind(links);
      vi.spyOn(links, "patchData").mockImplementationOnce(
        async (...args: unknown[]) => {
          patchIssued.resolve();
          await continuePatch.promise;
          return patch(...args);
        }
      );
    }
    const { adaptCloudI2vPromptFromLocal } =
      await import("@domains/prompt/api/adaptCloudI2vPromptFromLocal");
    const { VideoEngine } = await import("@models/video/types");
    const { rendererLibrary } = await import("@/platform/rendererLibraryWork");
    const work = rendererLibrary.capture();
    const pending = adaptCloudI2vPromptFromLocal(
      {
        prompt: "A camera move",
        sourceVideoTrackId: "same-track",
        referenceImageAssetIds: [],
        cloudEngine: VideoEngine.minimax_reference
      },
      work
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(readiness).toHaveBeenCalledOnce());
    if (stage !== "readiness") {
      await vi.waitFor(() =>
        expect(fixture.mutation).toHaveBeenCalledExactlyOnceWith(
          "/adapt_i2v_prompt",
          expect.objectContaining({
            reference_asset_ids: [missingSourceCloudId]
          }),
          { signal: work.signal }
        )
      );
    }
    if (stage === "issued stale write") await patchIssued.promise;
    const choosing = fixture.api.library.choose();
    if (stage === "issued stale write") {
      await vi.waitFor(() => expect(work.signal.aborted).toBe(true));
      expect(beforeLibraryChange).not.toHaveBeenCalled();
      continuePatch.resolve();
    }
    await choosing;
    const calls = fixture.calls.slice();
    if (stage === "readiness") ready.resolve(false);
    if (stage === "missing reference") adaptation.reject(missing);
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(fixture.calls).toEqual(calls);
    expect(
      fixture.calls.filter((call) => call === IPC_CHANNELS.projectsListAll)
    ).toHaveLength(stage === "readiness" ? 0 : 1);
    expect(
      fixture.calls.filter((call) => call === IPC_CHANNELS.cloudLinkPatch)
    ).toHaveLength(stage === "issued stale write" ? 1 : 0);
    expect(
      (await fixture.api.cloud.links.get("asset", sourceLinkId))?.data.status
    ).toBe("ingested");
    if (stage === "issued stale write") {
      await manager.open(roots[0]);
      expect(
        (await fixture.api.cloud.links.get("asset", sourceLinkId))?.data.status
      ).toBe("stale");
    }
    expect(fixture.putObject).not.toHaveBeenCalled();
  }
);

const sheetPlan = {
  id: "same-plan",
  project_id: "reused",
  local_operation: "sheets",
  local_executor: "mago-cloud-renderer",
  local_request: { settings: { render_model: "seedream_5_pro_t2i" } },
  local_targets: [
    { token: "same-key", name: "Mara", kind: "character", _local_prompt: "Ink" }
  ],
  status: "PAUSED",
  steps: [
    {
      id: "submit",
      status: "PENDING",
      tool_name: "submit_img2img_batch",
      tool_args: { token: "same-key" }
    },
    {
      id: "poll",
      status: "PENDING",
      tool_name: "poll_img2img_batch",
      tool_args: { token: "same-key" }
    }
  ]
};

it.each(["late acceptance", "accepted bookkeeping", "output body"] as const)(
  "keeps renderer acknowledgement and main teardown in order for cloud sheet %s",
  async (stage) => {
    const { manager, roots, snapshots, storage, beforeLibraryChange } =
      await setupLibraries("script_to_shots", "local");
    const seed = async (name: string) => {
      await snapshots.put({
        projectId: "reused",
        state: {
          sheets_timeline_id: "same-shot",
          keys: [{ token: "same-key", name, images: [] }]
        }
      });
      await snapshots.putPlan("reused", sheetPlan.id, { ...sheetPlan, name });
      await fixture.api.cloud.links.put({
        kind: "project",
        localId: "reused",
        cloudId: "cloud-project"
      });
      await fixture.api.cloud.links.put({
        kind: "timeline",
        localId: "same-shot",
        cloudId: "cloud-shot"
      });
    };
    await seed("original");
    await manager.open(roots[1]);
    await seed("replacement");
    await manager.open(roots[0]);
    await fixture.api.scriptProjects.resumePlan(sheetPlan.id);
    const issued = deferred();
    const release = deferred();
    const cancelled = deferred();
    const acceptance = {
      data: { clips: [{ id: "cloud-clip", asset: { id: "cloud-image" } }] }
    };
    if (stage === "late acceptance") {
      fixture.mutation.mockImplementationOnce(async () => {
        issued.resolve();
        await release.promise;
        return acceptance;
      });
    } else if (stage === "accepted bookkeeping") {
      const savePlan = snapshots.putPlan.bind(snapshots);
      vi.spyOn(snapshots, "putPlan").mockImplementation(async (...args) => {
        const plan = args[2] as typeof sheetPlan;
        if (
          plan.steps.some(
            (step) => step.id === "submit" && step.status === "COMPLETED"
          )
        ) {
          issued.resolve();
          await release.promise;
        }
        await savePlan(...args);
      });
    } else {
      storage.fetchFromCloudStorage.mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream({
              pull: () => {
                issued.resolve();
              },
              cancel: async () => {
                cancelled.resolve();
                await release.promise;
              }
            }),
            { headers: { "content-type": "image/png" } }
          )
      );
    }
    fixture.mutation.mockResolvedValue(acceptance);
    fixture.backend.mockImplementation(async (url: string) => ({
      data:
        url === "/assets/img2img/status/cloud-clip"
          ? {
              render_status: "SUCCESS",
              output_url: "https://fixture.invalid/output.png"
            }
          : { project_id: "cloud-project" }
    }));
    const { rendererLibrary } = await import("@/platform/rendererLibraryWork");
    const { executeCloudSheetPlan } = await import("./cloudSheetRender.local");
    const work = rendererLibrary.capture();
    const pending = executeCloudSheetPlan(sheetPlan.id, work);
    await issued.promise;
    const open = vi.spyOn(manager, "open");
    const choosing = fixture.api.library.choose();
    await vi.waitFor(() => expect(work.signal.aborted).toBe(true));
    if (stage === "output body") {
      await cancelled.promise;
      expect(beforeLibraryChange).toHaveBeenCalledOnce();
    } else if (stage === "accepted bookkeeping") {
      expect(beforeLibraryChange).not.toHaveBeenCalled();
    }
    if (stage !== "late acceptance") {
      expect(open).not.toHaveBeenCalled();
      release.resolve();
    }
    await choosing;
    release.resolve();
    const calls = fixture.calls.slice();
    await pending;
    expect(fixture.calls).toEqual(calls);
    expect(fixture.mutation.mock.calls.map(([url]) => url)).toEqual([
      "/assets/img2img/render"
    ]);
    expect(await snapshots.getPlan(sheetPlan.id)).toEqual({
      ...sheetPlan,
      name: "replacement"
    });
    await manager.open(roots[0]);
    const original = await snapshots.getPlan(sheetPlan.id);
    if (stage === "late acceptance") {
      expect(original).toMatchObject({
        name: "original",
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "submit",
            result: { token: "same-key", cloud_submission_pending: true }
          })
        ])
      });
      // Model reopening the interrupted plan as paused; keep its durable step results.
      await snapshots.putPlan("reused", sheetPlan.id, {
        ...original,
        status: "PAUSED"
      });
      await fixture.api.scriptProjects.resumePlan(sheetPlan.id);
      await executeCloudSheetPlan(sheetPlan.id, rendererLibrary.capture());
      expect(fixture.mutation).toHaveBeenCalledOnce();
      expect(await snapshots.getPlan(sheetPlan.id)).toMatchObject({
        status: "PAUSED",
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "submit",
            error: {
              message: expect.stringContaining("will not submit it again")
            }
          })
        ])
      });
    } else {
      expect(original).toMatchObject({
        name: "original",
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "submit",
            status: "COMPLETED",
            result: expect.objectContaining({ cloud_clip_id: "cloud-clip" })
          })
        ])
      });
    }
    expect((await snapshots.get("reused"))?.state?.keys).toEqual([
      { token: "same-key", name: "original", images: [] }
    ]);
  }
);

it.each(["key", "token"] as const)(
  "does not dispatch adaptation after an old library's delayed %s becomes available",
  async (stage) => {
    await setupLibraries();
    await installPromptReadiness(async () => false);
    const { backendApiClient, initializeBackendApiClient, setApiKey } =
      await vi.importActual<typeof import("@/lib/backend-api-client")>(
        "@/lib/backend-api-client"
      );
    const token = deferred<string>();
    const getToken = vi.fn(() => token.promise);
    const adapter = vi.fn(async () => {
      throw new Error("Unexpected transport dispatch");
    });
    initializeBackendApiClient(getToken, { waitForApiKey: stage === "key" });
    fixture.mutation.mockImplementation(
      (url: string, data: unknown, config: { signal: AbortSignal }) =>
        backendApiClient.post(url, data, { ...config, adapter })
    );
    const { adaptCloudI2vPromptFromLocal } =
      await import("@domains/prompt/api/adaptCloudI2vPromptFromLocal");
    const { rendererLibrary } = await import("@/platform/rendererLibraryWork");
    const { VideoEngine } = await import("@models/video/types");
    const pending = adaptCloudI2vPromptFromLocal(
      {
        prompt: "original",
        referenceImageAssetIds: [],
        cloudEngine: VideoEngine.minimax_reference
      },
      rendererLibrary.capture()
    ).catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(
        stage === "token" ? getToken : fixture.mutation
      ).toHaveBeenCalledOnce()
    );
    await fixture.api.library.choose();
    const calls = fixture.calls.slice();
    if (stage === "key") setApiKey("fixture-key");
    token.resolve("fixture-token");
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(adapter).not.toHaveBeenCalled();
    if (stage === "key") expect(getToken).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual(calls);
  }
);
