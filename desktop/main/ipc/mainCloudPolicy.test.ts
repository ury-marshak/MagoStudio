import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  profile: "",
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  protocols: new Map<string, (request: Request) => Promise<Response>>(),
  saveDialog: vi.fn(),
  uploadBytes: vi.fn(),
  uploadFile: vi.fn(),
  download: vi.fn()
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => state.profile,
    getAppPath: () => process.cwd()
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (...args: unknown[]) => Promise<unknown>
    ) => state.handlers.set(channel, handler)
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (
      scheme: string,
      handler: (request: Request) => Promise<Response>
    ) => state.protocols.set(scheme, handler)
  },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showSaveDialog: state.saveDialog }
}));
vi.mock("../cloud/uploadFile", () => ({
  uploadBytesToPresignedUrl: state.uploadBytes,
  uploadFileToPresignedUrl: state.uploadFile
}));
vi.mock("../cloud/downloadRenderOutput", () => ({
  downloadRenderOutput: state.download
}));

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS } from "../../shared/contracts";
import type { CloudLinkRepository } from "../cloud/cloudLinkRepository";
import type { CloudRenderJobRepository } from "../cloud/cloudRenderJobRepository";
import type { CloudRenderSubmitService } from "../cloud/cloudRenderSubmitService";
import { requireCloudAccount } from "../cloud/requireCloudAccount";
import type { UploadService } from "../cloud/uploadService";
import { fetchCloudStorageObject } from "../cloudStorage/fetchCloudStorageObject";
import type { CloudProjectMirrorRepository } from "../database/cloudProjectMirrorRepository";
import type { DatabaseManager } from "../database/databaseManager";
import type { ProjectRepository } from "../database/projectRepository";
import type { ScriptProjectSnapshotRepository } from "../database/scriptProjectSnapshotRepository";
import { LibrarySettings } from "../librarySettings";
import { LibraryWorkSession } from "../libraryWorkSession";
import { registerMediaProtocol } from "../rendererProtocol";
import type { LocalScriptChatService } from "../scriptProjects/localScriptChatService";
import type { LocalScriptProjectService } from "../scriptProjects/localScriptProjectService";

import { registerCloudHandlers } from "./registerCloudHandlers";
import { registerCloudStorageHandlers } from "./registerCloudStorageHandlers";
import { registerProjectHandlers } from "./registerProjectHandlers";
import { registerScriptProjectHandlers } from "./registerScriptProjectHandlers";

const config = resolveCloudConfig();
const remoteUrl = `https://${config.cloudStorageHosts[0]}/historical.mp4`;
const event = {
  senderFrame: { url: `https://${config.rendererHost}/` },
  sender: { isDestroyed: () => false, send: vi.fn() }
};
const invoke = (channel: string, ...args: unknown[]) =>
  state.handlers.get(channel)!(event, ...args);
let settings: LibrarySettings;
let imageSession: AbortController;
let renderWork: LibraryWorkSession<undefined>;
const effects = {
  getLink: vi.fn(),
  putLink: vi.fn(),
  patchLink: vi.fn(),
  resolve: vi.fn(),
  prepare: vi.fn(),
  upload: vi.fn(),
  register: vi.fn(),
  registerImage: vi.fn(),
  listActive: vi.fn(),
  listQueue: vi.fn(),
  update: vi.fn(),
  getJob: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  root: vi.fn(),
  open: vi.fn(),
  mirror: vi.fn(),
  cache: vi.fn(),
  snapshot: vi.fn(),
  cacheMedia: vi.fn()
};

beforeEach(async () => {
  vi.clearAllMocks();
  state.handlers.clear();
  state.protocols.clear();
  state.profile = await mkdtemp(path.join(tmpdir(), "mago-cloud-policy-"));
  settings = new LibrarySettings();
  imageSession = new AbortController();
  renderWork = new LibraryWorkSession(() => undefined);
  effects.root.mockResolvedValue(state.profile);
  effects.resolve.mockResolvedValue("/fixture/input.mp4");
  effects.prepare.mockResolvedValue({
    filePath: "/fixture/prepared.mp4",
    sizeBytes: 3,
    encoded: false
  });
  effects.getJob.mockResolvedValue({ request: {} });
  effects.listActive.mockResolvedValue([]);
  effects.listQueue.mockResolvedValue([]);
  state.download.mockResolvedValue({
    relativePath: "output.mp4",
    sizeBytes: 3
  });
  registerCloudHandlers({
    links: {
      libraryWork: new LibraryWorkSession(() => undefined),
      get: effects.getLink,
      put: effects.putLink,
      patchData: effects.patchLink
    } as unknown as CloudLinkRepository,
    uploads: {
      prepare: effects.prepare,
      upload: effects.upload
    } as unknown as UploadService,
    repository: {
      resolveMediaPath: effects.resolve
    } as unknown as ProjectRepository,
    renderJobs: {
      libraryWork: new LibraryWorkSession(() => undefined),
      listActive: effects.listActive,
      listQueue: effects.listQueue,
      update: effects.update,
      get: effects.getJob
    } as unknown as CloudRenderJobRepository,
    renderSubmits: {
      libraryWork: renderWork,
      register: effects.register,
      registerImage: effects.registerImage,
      complete: effects.complete,
      fail: effects.fail
    } as unknown as CloudRenderSubmitService,
    databaseManager: {} as DatabaseManager,
    getLibraryRoot: effects.root,
    settings,
    captureImageDescriptionSession: () => imageSession.signal
  });
  registerProjectHandlers(
    {} as ProjectRepository,
    {
      libraryWork: new LibraryWorkSession(() => undefined),
      put: effects.mirror,
      cacheAsset: effects.cache
    } as unknown as CloudProjectMirrorRepository,
    { isOpen: () => false, open: effects.open } as unknown as DatabaseManager,
    settings
  );
  registerScriptProjectHandlers({
    service: {
      inLibrary: (operation: () => Promise<unknown>) => operation(),
      capturePlanSession: () => new AbortController().signal,
      databaseOperation: (operation: () => Promise<unknown>) => operation(),
      putSnapshot: effects.snapshot,
      cacheMedia: effects.cacheMedia
    } as unknown as LocalScriptProjectService,
    chat: {} as LocalScriptChatService,
    databaseManager: { isOpen: () => true } as DatabaseManager,
    settings
  });
  registerCloudStorageHandlers(settings);
  registerMediaProtocol(
    { resolveMediaPath: effects.resolve } as unknown as ProjectRepository,
    {} as ScriptProjectSnapshotRepository,
    settings
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(state.profile, { recursive: true, force: true });
});

const requests: Array<[string, unknown[]]> = [
  [IPC_CHANNELS.cloudPrepareUpload, [{ assetId: "asset" }]],
  [
    IPC_CHANNELS.cloudUploadPrepared,
    [{ assetId: "asset", presignedUrl: "https://upload.invalid/" }]
  ],
  [
    IPC_CHANNELS.cloudUploadBytes,
    [
      {
        uploadId: "upload",
        bytes: new Uint8Array([1]),
        contentType: "image/png",
        presignedUrl: "https://upload.invalid/"
      }
    ]
  ],
  [
    IPC_CHANNELS.cloudUploadAsset,
    [{ assetId: "asset", presignedUrl: "https://upload.invalid/" }]
  ],
  [
    IPC_CHANNELS.cloudRenderRegister,
    [
      {
        outputTrackId: "track",
        sourceAssetId: "asset",
        model: "model",
        frameRange: [0, 120],
        fps: 24,
        cloudAssetId: "remote"
      }
    ]
  ],
  [
    IPC_CHANNELS.cloudImageRenderRegister,
    [
      {
        projectId: "project",
        shotId: "shot",
        sourceAssetId: "asset",
        model: "model",
        frame: 0,
        name: "image",
        cloudAssetId: "remote",
        cloudClipId: "clip"
      }
    ]
  ],
  [IPC_CHANNELS.cloudRenderFinish, [{ jobId: "job", url: remoteUrl }]],
  [
    IPC_CHANNELS.projectsMirrorCloud,
    [{ project: { id: "project" }, includeContent: true }]
  ],
  [
    IPC_CHANNELS.projectsCacheCloudAsset,
    [{ projectId: "project", assetId: "asset", sourceUrl: remoteUrl }]
  ],
  [IPC_CHANNELS.scriptProjectsCacheMedia, ["project", remoteUrl]],
  [IPC_CHANNELS.filesSaveCloudStorageObjectAs, [{ url: remoteUrl }]]
];

describe("trusted main cloud boundary", () => {
  test.each(requests)(
    "refuses %s before account-free side effects",
    async (channel, args) => {
      await expect(invoke(channel, ...args)).rejects.toThrow(
        "explicit cloud account"
      );
      for (const effect of Object.values(effects))
        expect(effect).not.toHaveBeenCalled();
      expect(state.uploadBytes).not.toHaveBeenCalled();
      expect(state.uploadFile).not.toHaveBeenCalled();
      expect(state.download).not.toHaveBeenCalled();
      expect(state.saveDialog).not.toHaveBeenCalled();
    }
  );

  test.each(["offline", "cloud ", "CLOUD", null])(
    "does not treat saved %s as cloud permission",
    async (mode) => {
      await writeFile(
        path.join(state.profile, "settings.json"),
        JSON.stringify({ appMode: mode })
      );
      await expect(
        invoke(IPC_CHANNELS.cloudUploadBytes, ...requests[2][1])
      ).rejects.toThrow("explicit cloud account");
      expect(state.uploadBytes).not.toHaveBeenCalled();
    }
  );

  test("untrusted senders are refused even in deliberately saved cloud mode", async () => {
    await settings.setAppMode("cloud");
    await expect(
      state.handlers.get(IPC_CHANNELS.cloudUploadBytes)!(
        { ...event, senderFrame: { url: "https://attacker.invalid/" } },
        ...requests[2][1]
      )
    ).rejects.toThrow("untrusted renderer");
    expect(state.uploadBytes).not.toHaveBeenCalled();
  });

  test("deliberate cloud mode permits uploads, registrations and ingestion", async () => {
    await settings.setAppMode("cloud");
    for (const index of [0, 1, 2, 4, 5, 6, 7, 8, 9])
      await invoke(requests[index][0], ...requests[index][1]);
    for (const effect of [
      effects.prepare,
      effects.upload,
      state.uploadBytes,
      effects.register,
      effects.registerImage,
      state.download,
      effects.complete,
      effects.mirror,
      effects.cache,
      effects.cacheMedia
    ])
      expect(effect).toHaveBeenCalled();
  });

  test("rechecks account choice after delayed preparation before uploading", async () => {
    await settings.setAppMode("cloud");
    let release!: (value: unknown) => void;
    effects.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = invoke(IPC_CHANNELS.cloudUploadPrepared, ...requests[1][1]);
    const rejected = expect(pending).rejects.toThrow("explicit cloud account");
    await vi.waitFor(() => expect(release).toBeDefined());
    await settings.clearAppMode();
    release({ filePath: "/fixture/prepared.mp4" });
    await rejected;
    expect(effects.upload).not.toHaveBeenCalled();
  });

  test("historical link and queue metadata remains accessible without a cloud account", async () => {
    await invoke(IPC_CHANNELS.cloudLinkGet, "project", "project");
    await invoke(IPC_CHANNELS.cloudRenderListQueue);
    await invoke(IPC_CHANNELS.cloudRenderListActive);
    expect(effects.getLink).toHaveBeenCalledWith("project", "project");
    expect(effects.listQueue).toHaveBeenCalled();
    expect(effects.listActive).toHaveBeenCalled();
  });

  test("saving a historical snapshot retains remote URLs as metadata, not download permission", async () => {
    const snapshot = {
      projectId: "historical",
      state: { url: remoteUrl },
      cut: { saved: true }
    };
    await invoke(IPC_CHANNELS.scriptProjectsPut, snapshot);
    expect(effects.snapshot).toHaveBeenCalledWith({
      ...snapshot,
      metadataOnly: true
    });
    expect(effects.cacheMedia).not.toHaveBeenCalled();
    await settings.setAppMode("cloud");
    await invoke(IPC_CHANNELS.scriptProjectsPut, snapshot);
    expect(effects.snapshot).toHaveBeenLastCalledWith({
      ...snapshot,
      metadataOnly: false
    });
  });

  test("account-free historical protocol URL is forbidden without transport", async () => {
    const fetchTrap = vi.fn(() => {
      throw new Error("unexpected transport");
    });
    vi.stubGlobal("fetch", fetchTrap);
    const response = await state.protocols.get("mago-media")!(
      new Request(
        `mago-media://cloud-storage/?url=${encodeURIComponent(remoteUrl)}`
      )
    );
    expect(response.status).toBe(403);
    expect(fetchTrap).not.toHaveBeenCalled();
    expect(effects.resolve).not.toHaveBeenCalled();
  });

  test("cloud protocol access still validates hosts and passes byte ranges", async () => {
    await settings.setAppMode("cloud");
    const fetchTrap = vi.fn(async () => new Response("bytes", { status: 206 }));
    vi.stubGlobal("fetch", fetchTrap);
    const handler = state.protocols.get("mago-media")!;
    expect(
      (
        await handler(
          new Request(
            `mago-media://cloud-storage/?url=${encodeURIComponent("https://attacker.invalid/a")}`
          )
        )
      ).status
    ).toBe(403);
    expect(fetchTrap).not.toHaveBeenCalled();
    expect(
      (
        await handler(
          new Request(
            `mago-media://cloud-storage/?url=${encodeURIComponent(remoteUrl)}`,
            { headers: { range: "bytes=0-4" } }
          )
        )
      ).status
    ).toBe(206);
    expect(fetchTrap).toHaveBeenCalledExactlyOnceWith(
      new URL(remoteUrl),
      expect.objectContaining({
        headers: { range: "bytes=0-4" },
        credentials: "omit"
      })
    );
  });

  test("save dialog is not continuing permission after sign-out", async () => {
    await settings.setAppMode("cloud");
    state.saveDialog.mockImplementationOnce(async () => {
      await settings.clearAppMode();
      return {
        filePath: path.join(state.profile, "download.mp4"),
        canceled: false
      };
    });
    const fetchTrap = vi.fn(() => {
      throw new Error("unexpected transport");
    });
    vi.stubGlobal("fetch", fetchTrap);
    await expect(
      invoke(IPC_CHANNELS.filesSaveCloudStorageObjectAs, { url: remoteUrl })
    ).rejects.toThrow("explicit cloud account");
    expect(fetchTrap).not.toHaveBeenCalled();
  });
});

test("corrupt account settings fail closed before transfer", async () => {
  await writeFile(path.join(state.profile, "settings.json"), "{broken");
  await expect(
    invoke(IPC_CHANNELS.cloudUploadBytes, ...requests[2][1])
  ).rejects.toThrow("settings file is damaged");
  expect(state.uploadBytes).not.toHaveBeenCalled();
});

test("cloud save downloads an allowlisted historical file after explicit choice", async () => {
  await settings.setAppMode("cloud");
  const destination = path.join(state.profile, "saved.mp4");
  state.saveDialog.mockResolvedValueOnce({
    filePath: destination,
    canceled: false
  });
  const fetchTrap = vi.fn(async () => new Response("historical bytes"));
  vi.stubGlobal("fetch", fetchTrap);
  expect(
    await invoke(IPC_CHANNELS.filesSaveCloudStorageObjectAs, { url: remoteUrl })
  ).toBe(true);
  expect(await readFile(destination, "utf8")).toBe("historical bytes");
  expect(fetchTrap).toHaveBeenCalledOnce();
});

test("cancelled save keeps the historical object remote", async () => {
  await settings.setAppMode("cloud");
  state.saveDialog.mockResolvedValueOnce({ canceled: true });
  const fetchTrap = vi.fn(() => {
    throw new Error("unexpected transport");
  });
  vi.stubGlobal("fetch", fetchTrap);
  expect(
    await invoke(IPC_CHANNELS.filesSaveCloudStorageObjectAs, { url: remoteUrl })
  ).toBe(false);
  expect(fetchTrap).not.toHaveBeenCalled();
});

test("sign-out during an allowed redirect stops the next protocol request", async () => {
  await settings.setAppMode("cloud");
  const fetchTrap = vi.fn(async () => {
    await settings.clearAppMode();
    return new Response("redirect body", {
      status: 307,
      headers: { location: remoteUrl + "?redirected=1" }
    });
  });
  vi.stubGlobal("fetch", fetchTrap);
  const response = await state.protocols.get("mago-media")!(
    new Request(
      `mago-media://cloud-storage/?url=${encodeURIComponent(remoteUrl)}`
    )
  );
  expect(response.status).toBe(403);
  expect(fetchTrap).toHaveBeenCalledOnce();
});

test("storage permission precedes the first dispatch and is rechecked on redirects", async () => {
  const fetchTrap = vi.fn(
    async () =>
      new Response(null, {
        status: 307,
        headers: { location: remoteUrl + "?redirected=1" }
      })
  );
  const assertAccess = () => requireCloudAccount(settings);
  const request = () =>
    fetchCloudStorageObject({
      url: remoteUrl,
      allowedHosts: config.cloudStorageHosts,
      assertAccess,
      fetchFromCloudStorage: fetchTrap
    });
  await expect(request()).rejects.toThrow("explicit cloud account");
  expect(fetchTrap).not.toHaveBeenCalled();
  await settings.setAppMode("cloud");
  fetchTrap.mockImplementationOnce(async () => {
    await settings.setAppMode("offline");
    return new Response(null, {
      status: 307,
      headers: { location: remoteUrl + "?redirected=1" }
    });
  });
  await expect(request()).rejects.toThrow("explicit cloud account");
  expect(fetchTrap).toHaveBeenCalledOnce();
});

test("an aborted storage request cannot dispatch after a delayed permission read", async () => {
  const controller = new AbortController();
  const fetchTrap = vi.fn();
  let release!: () => void;
  const pending = fetchCloudStorageObject({
    url: remoteUrl,
    allowedHosts: config.cloudStorageHosts,
    signal: controller.signal,
    assertAccess: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    fetchFromCloudStorage: fetchTrap
  });
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  release();
  await rejected;
  expect(fetchTrap).not.toHaveBeenCalled();
});

test("cloud-finish IPC captures description ownership before the account/root/download awaits", async () => {
  const old = imageSession;
  let release!: (mode: "cloud") => void;
  vi.spyOn(settings, "getAppMode").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = invoke(IPC_CHANNELS.cloudRenderFinish, {
    jobId: "job",
    url: remoteUrl
  });
  old.abort();
  imageSession = new AbortController();
  release("cloud");
  await pending;
  expect(effects.complete).toHaveBeenCalledExactlyOnceWith(
    { jobId: "job", relativePath: "output.mp4", sizeBytes: 3 },
    old.signal
  );
  vi.restoreAllMocks();
});

test.each([
  IPC_CHANNELS.cloudRenderRegister,
  IPC_CHANNELS.cloudImageRenderRegister,
  IPC_CHANNELS.cloudRenderFinish
])(
  "%s retains ingestion ownership before delayed account permission",
  async (channel) => {
    let release!: (value: "cloud") => void;
    vi.spyOn(settings, "getAppMode").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const args = requests.find(([name]) => name === channel)![1];
    const pending = invoke(channel, ...args);
    const rejected = expect(pending).rejects.toThrow();
    await renderWork.suspend();
    renderWork.reset();
    release("cloud");
    await rejected;
    for (const effect of [
      effects.root,
      effects.register,
      effects.registerImage,
      effects.getJob,
      effects.complete,
      state.download
    ])
      expect(effect).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
);

test("cloud finish drains an issued download and suppresses late progress/completion after reset", async () => {
  await settings.setAppMode("cloud");
  let release!: (value: unknown) => void;
  state.download.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = invoke(IPC_CHANNELS.cloudRenderFinish, {
    jobId: "job",
    url: remoteUrl
  });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeDefined());
  const input = state.download.mock.calls.at(-1)![0];
  let suspended = false;
  const suspension = renderWork.suspend().then(() => {
    suspended = true;
  });
  await Promise.resolve();
  expect(suspended).toBe(false);
  expect(input.signal.aborted).toBe(true);
  event.sender.send.mockClear();
  input.onProgress(0.9);
  expect(event.sender.send).not.toHaveBeenCalled();
  release({ relativePath: "output.mp4", sizeBytes: 3 });
  await suspension;
  renderWork.reset();
  await rejected;
  expect(effects.complete).not.toHaveBeenCalled();
});

test("suspended ingestion refuses terminal failure and registration without new policy or repository work", async () => {
  await renderWork.suspend();
  const policy = vi.spyOn(settings, "getAppMode");
  for (const channel of [
    IPC_CHANNELS.cloudRenderRegister,
    IPC_CHANNELS.cloudImageRenderRegister,
    IPC_CHANNELS.cloudRenderFinish
  ]) {
    const args = requests.find(([name]) => name === channel)![1];
    await expect(invoke(channel, ...args)).rejects.toThrow();
  }
  await expect(
    invoke(IPC_CHANNELS.cloudRenderFail, { jobId: "job", message: "late" })
  ).rejects.toThrow();
  expect(policy).not.toHaveBeenCalled();
  expect(effects.fail).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
