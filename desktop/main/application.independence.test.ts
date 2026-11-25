import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userData: "",
  appListeners: new Map<string, () => void>(),
  handlers: new Map<string, unknown>(),
  events: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  nextLoad: undefined as (() => Promise<void>) | undefined,
  protocols: new Map<string, unknown>(),
  windows: [] as Array<{
    options: { webPreferences: { additionalArguments: string[] } };
    loadURL: ReturnType<typeof vi.fn>;
    webContents: { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> };
  }>,
  key: vi.fn(),
  netFetch: vi.fn(),
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
  exit: vi.fn(),
  quit: vi.fn(),
  dialog: vi.fn(),
  save: vi.fn(),
  choose: vi.fn()
}));
vi.mock("electron", () => {
  const protocol = {
    handle: (scheme: string, handler: unknown) =>
      mocks.protocols.set(scheme, handler),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn()
  };
  const session = {
    defaultSession: { protocol, setCertificateVerifyProc: vi.fn() }
  };
  class BrowserWindow {
    static getAllWindows = () => mocks.windows;
    static fromWebContents = () => mocks.windows[0];
    options;
    private destroyed = false;
    loadURL = vi.fn(async (url: string) => {
      this.webContents.mainFrame.url = url;
      const nextLoad = mocks.nextLoad;
      mocks.nextLoad = undefined;
      await nextLoad?.();
    });
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => this.destroyed,
      mainFrame: { url: "" },
      send: vi.fn(),
      session: session.defaultSession
    });
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.webContents.emit("destroyed");
      const index = mocks.windows.indexOf(this);
      if (index >= 0) mocks.windows.splice(index, 1);
    }
    on = vi.fn();
    once = vi.fn();
    constructor(options: {
      webPreferences: { additionalArguments: string[] };
    }) {
      this.options = options;
      mocks.windows.push(this);
    }
  }
  return {
    app: {
      isPackaged: false,
      getPath: () => mocks.userData,
      getAppPath: () => process.cwd(),
      getVersion: () => "fixture",
      commandLine: { appendSwitch: vi.fn() },
      setAsDefaultProtocolClient: vi.fn(),
      requestSingleInstanceLock: () => true,
      on: (event: string, callback: () => void) =>
        mocks.appListeners.set(event, callback),
      whenReady: async () => {},
      quit: mocks.quit,
      exit: mocks.exit
    },
    BrowserWindow,
    ipcMain: {
      handle: (name: string, handler: unknown) =>
        mocks.handlers.set(name, handler),
      on: (
        name: string,
        handler: (event: unknown, ...args: unknown[]) => void
      ) => mocks.events.set(name, handler),
      removeHandler: vi.fn()
    },
    session,
    protocol,
    net: { fetch: mocks.netFetch },
    nativeImage: {},
    dialog: {
      showMessageBox: mocks.dialog,
      showMessageBoxSync: mocks.dialog,
      showSaveDialog: mocks.save,
      showOpenDialog: mocks.choose
    },
    shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() }
  };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // Also prevents OS Keychain reads: never call /usr/bin/security in this harness.
  execFile: mocks.key,
  execFileSync: mocks.key,
  spawn: mocks.key
}));
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  request: mocks.httpRequest
}));
vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  request: mocks.httpsRequest
}));

let root: string;
const transport = vi.fn();
const socket = vi.fn();
afterEach(async () => {
  mocks.appListeners.get("before-quit")?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.each(["fal", "text", "vision"])(
  "composes account-free main startup with a %s-only no-credential profile and a historical local queue",
  async (capability) => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.appListeners.clear();
    mocks.handlers.clear();
    mocks.events.clear();
    mocks.nextLoad = undefined;
    mocks.protocols.clear();
    mocks.windows.length = 0;
    root = await mkdtemp(path.join(tmpdir(), "mago-main-network-audit-"));
    mocks.userData = path.join(root, "profile");
    await mkdir(mocks.userData);
    const library = path.join(root, "library");
    await writeFile(
      path.join(mocks.userData, "settings.json"),
      JSON.stringify({ libraryRoot: library })
    );
    await writeFile(
      path.join(mocks.userData, "external-providers.json"),
      JSON.stringify({
        [capability]:
          capability === "fal"
            ? { keychainAccount: "nonexistent-audit-account" }
            : {
                baseUrl: "https://inference.invalid/api/v1",
                model: "fixture",
                keychainAccount: "nonexistent-audit-account"
              }
      })
    );
    // Trap both Node and Electron network paths, not just Chromium/console logs.
    transport.mockRejectedValue(new Error("Unexpected Node fetch"));
    mocks.netFetch.mockRejectedValue(
      new Error("Unexpected Electron net fetch")
    );
    mocks.key.mockImplementation(() => {
      throw new Error("Child processes and credential access are forbidden");
    });
    vi.stubGlobal("fetch", transport);
    vi.stubGlobal("WebSocket", socket);
    vi.stubEnv("MAGO_PACKAGED_SMOKE", "1");
    vi.stubEnv("MAGO_RENDERER_URL", "");
    vi.stubEnv(
      "MAGO_MIGRATIONS_PATH",
      path.join(process.cwd(), "desktop/main/database/migrations")
    );
    mocks.httpRequest.mockImplementation(() => {
      throw new Error("Unexpected HTTP request");
    });
    mocks.httpsRequest.mockImplementation(() => {
      throw new Error("Unexpected HTTPS request");
    });
    const { DatabaseManager } = await import("./database/databaseManager.js");
    const {
      assets,
      clips,
      imageRenderJobs,
      projects,
      shots,
      tracks,
      scriptProjectSnapshots,
      scriptProjectMedia
    } = await import("./database/schema.js");
    const { IPC_CHANNELS } = await import("../shared/contracts.js");
    const { resolveCloudConfig } = await import("../shared/cloudConfig.js");
    const config = resolveCloudConfig();
    const historicalUrl = `https://${config.cloudStorageHosts[0]}/historical.mp4`;
    const seed = new DatabaseManager();
    await seed.open(library);
    try {
      const db = seed.get();
      await db.insert(projects).values({ id: "project", name: "Fixture" });
      await db
        .insert(shots)
        .values({ id: "shot", projectId: "project", name: "Fixture" });
      await db.insert(tracks).values({
        id: "track",
        projectId: "project",
        shotId: "shot",
        name: "Fixture",
        type: "image"
      });
      await db.insert(assets).values({
        id: "asset",
        name: "Fixture",
        type: "image",
        sourcePath: path.join(library, "missing.png"),
        width: 640,
        height: 480,
        status: "INQUEUE"
      });
      await db.insert(clips).values({
        id: "clip",
        trackId: "track",
        assetId: "asset",
        name: "Fixture"
      });
      await db.insert(imageRenderJobs).values({
        id: "historical-local",
        projectId: "project",
        shotId: "shot",
        trackId: "track",
        clipId: "clip",
        assetId: "asset",
        model: "qwen",
        status: "INQUEUE",
        providerRequestId: "accepted-comfy-prompt",
        requestJson: JSON.stringify({
          frame: 0,
          settings: {},
          referenceImageIds: [],
          comfyEndpoint: "http://localhost:8188"
        })
      });
      await db.insert(projects).values({
        id: "cloud-history",
        name: "Saved cloud project",
        settingsJson: JSON.stringify({
          origin: "cloud",
          type: "script_to_shots"
        })
      });
      await db.insert(scriptProjectSnapshots).values({
        projectId: "cloud-history",
        stateJson: JSON.stringify({
          uncached: { url: historicalUrl },
          cached: { url: "mago-media://script-project/cached" }
        }),
        cutJson: JSON.stringify({ versions: [{ id: "historical-output" }] })
      });
      await writeFile(
        path.join(library, "cached.mp4"),
        "local historical output"
      );
      await db.insert(scriptProjectMedia).values({
        id: "cached",
        projectId: "cloud-history",
        sourceUrl: `${historicalUrl}/cached.mp4`,
        relativePath: "cached.mp4"
      });
    } finally {
      seed.close();
    }
    const { ImageRenderService } =
      await import("./imageRenders/imageRenderService.js");
    const start = vi.spyOn(ImageRenderService.prototype, "start");
    const kick = vi.spyOn(ImageRenderService.prototype, "kick");
    await import("./application.js");
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(kick).toHaveResolvedWith(undefined));
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].options.webPreferences.additionalArguments).toEqual(
      ["--mago-app-mode=offline"]
    );
    expect(mocks.windows[0].loadURL).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^https:\/\//)
    );
    expect(mocks.protocols.has("https")).toBe(true);
    const { listLibraryIssues } = await import("./libraryHealth.js");
    expect(listLibraryIssues()).toEqual([]);
    // Exercise the real application wiring, not renderer account gates. Saved
    // remote URLs and trusted IPC cannot authorize uploads/downloads by themselves.
    const invoke = (channel: string, ...args: unknown[]) =>
      (
        mocks.handlers.get(channel) as (
          event: unknown,
          ...args: unknown[]
        ) => Promise<unknown>
      )(
        {
          senderFrame: mocks.windows[0].webContents.mainFrame,
          sender: mocks.windows[0].webContents
        },
        ...args
      );
    const uploadRequests: Array<[string, unknown[]]> = [
      [IPC_CHANNELS.cloudPrepareUpload, [{ assetId: "asset" }]],
      [
        IPC_CHANNELS.cloudUploadPrepared,
        [{ assetId: "asset", presignedUrl: "https://upload.invalid/" }]
      ],
      [
        IPC_CHANNELS.cloudUploadBytes,
        [
          {
            uploadId: "bytes",
            bytes: new Uint8Array([1]),
            presignedUrl: "https://upload.invalid/",
            contentType: "image/png"
          }
        ]
      ],
      [
        IPC_CHANNELS.cloudUploadAsset,
        [{ assetId: "asset", presignedUrl: "https://upload.invalid/" }]
      ]
    ];
    for (const [channel, args] of [
      ...uploadRequests,
      [IPC_CHANNELS.cloudRenderRegister, [{}]],
      [IPC_CHANNELS.cloudImageRenderRegister, [{}]],
      [
        IPC_CHANNELS.cloudRenderFinish,
        [{ jobId: "historical-local", url: historicalUrl }]
      ],
      [
        IPC_CHANNELS.projectsMirrorCloud,
        [{ project: { id: "cloud-history" }, includeContent: true }]
      ],
      [
        IPC_CHANNELS.projectsCacheCloudAsset,
        [
          {
            projectId: "cloud-history",
            assetId: "asset",
            sourceUrl: historicalUrl
          }
        ]
      ],
      [IPC_CHANNELS.scriptProjectsCacheMedia, ["cloud-history", historicalUrl]],
      [IPC_CHANNELS.filesSaveCloudStorageObjectAs, [{ url: historicalUrl }]]
    ] as Array<[string, unknown[]]>) {
      await expect(invoke(channel, ...args)).rejects.toThrow(
        "explicit cloud account"
      );
    }
    await expect(
      invoke(IPC_CHANNELS.cloudAssetInfo, "asset")
    ).resolves.toMatchObject({
      id: "asset",
      name: "Fixture",
      width: 640
    });
    await expect(
      invoke(IPC_CHANNELS.cloudCancelUploadBytes, "bytes")
    ).resolves.toBeUndefined();
    await invoke(IPC_CHANNELS.scriptProjectsPut, {
      projectId: "cloud-history",
      state: {
        uncached: { url: historicalUrl },
        cached: { url: "mago-media://script-project/cached" }
      }
    });
    expect(
      await invoke(IPC_CHANNELS.scriptProjectsGet, "cloud-history")
    ).toMatchObject({
      state: { uncached: { url: historicalUrl } },
      cut: { versions: [{ id: "historical-output" }] }
    });
    expect(
      await invoke(IPC_CHANNELS.projectsGet, "cloud-history")
    ).toMatchObject({ id: "cloud-history", name: "Saved cloud project" });
    const media = mocks.protocols.get("mago-media") as (
      request: Request
    ) => Promise<Response>;
    expect(
      (
        await media(
          new Request(
            `mago-media://cloud-storage/?url=${encodeURIComponent(historicalUrl)}`
          )
        )
      ).status
    ).toBe(403);
    const cached = await media(
      new Request("mago-media://script-project/cached", {
        headers: { range: "bytes=0-4" }
      })
    );
    expect(cached.status).toBe(206);
    expect(await cached.text()).toBe("local");
    expect(listLibraryIssues()).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(mocks.netFetch).not.toHaveBeenCalled();
    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.key).not.toHaveBeenCalled();
    expect(mocks.exit).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.dialog).not.toHaveBeenCalled();
    // Actual composition must reset media only after successful opening/settings
    // and cancel old response bodies even if the same media ID exists again.
    const replacement = path.join(root, "replacement");
    await seed.open(replacement);
    const replacementMedia = path.join(replacement, "fixture.png");
    await writeFile(replacementMedia, "replacement local bytes");
    await seed.get().insert(assets).values({
      id: "asset",
      name: "Reused",
      type: "image",
      sourcePath: replacementMedia,
      width: 1280,
      height: 720,
      status: "available"
    });
    seed.close();
    const staleBody = await media(
      new Request("mago-media://script-project/cached")
    );
    mocks.choose.mockResolvedValue({
      canceled: false,
      filePaths: [replacement]
    });
    await invoke(IPC_CHANNELS.libraryChoose);
    await expect(staleBody.text()).rejects.toThrow();
    const replacementBody = await media(
      new Request("mago-media://asset/asset")
    );
    expect(await replacementBody.text()).toBe("replacement local bytes");
    await expect(
      invoke(IPC_CHANNELS.cloudAssetInfo, "asset")
    ).resolves.toMatchObject({
      id: "asset",
      name: "Reused",
      width: 1280
    });
    await expect(
      invoke(IPC_CHANNELS.cloudCancelUploadBytes, "bytes")
    ).resolves.toBeUndefined();
    await expect(
      invoke(IPC_CHANNELS.vlmSaveAutoPrompt, {
        assetId: "asset",
        videoAssetId: "video",
        version: "img2img_mago",
        positivePrompt: "replacement prompt"
      })
    ).resolves.toMatchObject({
      id: "asset",
      data: { auto_prompt: [{ positive_prompt: "replacement prompt" }] }
    });
    await expect(invoke(IPC_CHANNELS.imageRendersListQueue)).resolves.toEqual(
      []
    );
    await expect(
      invoke(IPC_CHANNELS.cloudRenderFail, {
        jobId: "missing",
        message: "fixture"
      })
    ).resolves.toBeUndefined();
    // The real application must reset the new repository owners as well.
    await expect(
      invoke(IPC_CHANNELS.projectsMirrorCloud, { project: { id: "asset" } })
    ).rejects.toThrow("explicit cloud account");
    await expect(
      invoke(IPC_CHANNELS.scriptProjectsGet, "missing")
    ).resolves.toBeNull();
    await expect(invoke(IPC_CHANNELS.cloudRenderListActive)).resolves.toEqual(
      []
    );
    await expect(invoke(IPC_CHANNELS.cloudRenderListQueue)).resolves.toEqual(
      []
    );
    await invoke(IPC_CHANNELS.cloudLinkPut, {
      kind: "project",
      localId: "replacement",
      cloudId: "fixture-remote",
      data: { cached: true }
    });
    await expect(
      invoke(IPC_CHANNELS.cloudLinkGet, "project", "replacement")
    ).resolves.toMatchObject({
      cloudId: "fixture-remote",
      data: { cached: true }
    });
    const failed = path.join(root, "failed-replacement");
    await mkdir(failed);
    const open = vi
      .spyOn(DatabaseManager.prototype, "open")
      .mockRejectedValueOnce(new Error("fixture failed open"));
    mocks.choose.mockResolvedValue({ canceled: false, filePaths: [failed] });
    await expect(invoke(IPC_CHANNELS.libraryChoose)).rejects.toThrow(
      "fixture failed open"
    );
    await expect(
      invoke(IPC_CHANNELS.vlmSaveAutoPrompt, {
        assetId: "asset",
        videoAssetId: "video",
        version: "img2img_mago",
        positivePrompt: "stale prompt"
      })
    ).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.vlmStatus)).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.imageRendersListQueue)).rejects.toThrow();
    await expect(
      invoke(IPC_CHANNELS.cloudRenderFail, {
        jobId: "missing",
        message: "late fixture"
      })
    ).rejects.toThrow();
    expect((await media(new Request("mago-media://asset/asset"))).status).toBe(
      404
    );
    await expect(
      invoke(IPC_CHANNELS.assetsExtractVideoFrame, {
        assetId: "asset",
        frameNumber: 0,
        fps: 24
      })
    ).rejects.toThrow();
    for (const [channel, args] of [
      ...uploadRequests,
      [IPC_CHANNELS.cloudAssetInfo, ["asset"]],
      [IPC_CHANNELS.cloudCancelUploadBytes, ["bytes"]],
      [IPC_CHANNELS.projectsMirrorCloud, [{ project: { id: "asset" } }]],
      [
        IPC_CHANNELS.projectsCacheCloudAsset,
        [{ projectId: "asset", assetId: "asset", sourceUrl: historicalUrl }]
      ],
      [IPC_CHANNELS.scriptProjectsCacheMedia, ["asset", historicalUrl]],
      [IPC_CHANNELS.cloudLinkGet, ["project", "replacement"]],
      [
        IPC_CHANNELS.cloudLinkPut,
        [{ kind: "project", localId: "replacement", cloudId: "late" }]
      ],
      [
        IPC_CHANNELS.cloudLinkPatch,
        [{ kind: "project", localId: "replacement", patch: { late: true } }]
      ],
      [IPC_CHANNELS.cloudRenderListActive, []],
      [IPC_CHANNELS.cloudRenderListQueue, []],
      [
        IPC_CHANNELS.cloudRenderSetStatus,
        [{ jobId: "missing", status: "SUCCESS" }]
      ],
      [IPC_CHANNELS.imageRendersCancel, ["missing"]],
      [IPC_CHANNELS.imageRendersMarkInteracted, ["missing"]],
      [IPC_CHANNELS.scriptProjectsGet, ["asset"]]
    ] as Array<[string, unknown[]]>) {
      await expect(invoke(channel, ...args)).rejects.toMatchObject({
        name: "AbortError"
      });
    }
    expect(transport).not.toHaveBeenCalled();
    expect(mocks.key).not.toHaveBeenCalled();
    open.mockRestore();
    // This harness does not execute Chromium or assert renderer-wide containment.
    mocks.appListeners.get("before-quit")?.();
    mocks.appListeners.delete("before-quit");
    await seed.open(library);
    try {
      expect(await seed.get().select().from(imageRenderJobs)).toMatchObject([
        {
          id: "historical-local",
          status: "INQUEUE",
          providerRequestId: "accepted-comfy-prompt"
        }
      ]);
      expect(await seed.get().select().from(scriptProjectMedia)).toMatchObject([
        { id: "cached", relativePath: "cached.mp4" }
      ]);
      expect(
        await seed.get().select().from(scriptProjectSnapshots)
      ).toMatchObject([
        {
          projectId: "cloud-history",
          cutJson: JSON.stringify({ versions: [{ id: "historical-output" }] })
        }
      ]);
    } finally {
      seed.close();
    }
  }
);

it("retires issued Cloud media, drains an active Save As, and rejects old IPC after same-library account ABA", async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.appListeners.clear();
  mocks.handlers.clear();
  mocks.events.clear();
  mocks.protocols.clear();
  mocks.windows.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "mago-account-transition-"));
  mocks.userData = path.join(root, "profile");
  const library = path.join(root, "library");
  await mkdir(mocks.userData);
  const settingsPath = path.join(mocks.userData, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ libraryRoot: library, appMode: "cloud" })
  );
  vi.stubEnv("MAGO_PACKAGED_SMOKE", "1");
  vi.stubEnv("MAGO_RENDERER_PORT", "47235");
  vi.stubEnv("MAGO_RENDERER_URL", "");
  vi.stubEnv(
    "MAGO_MIGRATIONS_PATH",
    path.join(process.cwd(), "desktop/main/database/migrations")
  );
  vi.stubGlobal("fetch", transport);
  vi.stubGlobal("WebSocket", socket);
  transport.mockRejectedValue(new Error("Unexpected Node fetch"));
  const { IPC_CHANNELS } = await import("../shared/contracts.js");
  const { resolveCloudConfig } = await import("../shared/cloudConfig.js");
  const { DatabaseManager } = await import("./database/databaseManager.js");
  const open = vi.spyOn(DatabaseManager.prototype, "open");
  const { ImageRenderService } =
    await import("./imageRenders/imageRenderService.js");
  const start = vi
    .spyOn(ImageRenderService.prototype, "startWithRecovery")
    .mockImplementation(() => undefined);
  await import("./application.js");
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  const historical =
    "https://" + resolveCloudConfig().cloudStorageHosts[0] + "/historical.mp4";
  const cloudUrl =
    "mago-media://cloud-storage/?url=" + encodeURIComponent(historical);
  const media = mocks.protocols.get("mago-media") as (
    request: Request
  ) => Promise<Response>;
  let deliver!: (response: Response) => void;
  const upstream = new Promise<Response>((resolve) => {
    deliver = resolve;
  });
  transport.mockReturnValueOnce(upstream);
  const pending = media(new Request(cloudUrl));
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  let closeStreaming!: () => void;
  const streamingClosed = new Promise<void>((resolve) => {
    closeStreaming = resolve;
  });
  const streamingCanceled = vi.fn(() => streamingClosed);
  transport.mockResolvedValueOnce(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([7]));
        },
        cancel: streamingCanceled
      })
    )
  );
  const streaming = (await media(new Request(cloudUrl))).body!.getReader();
  await expect(streaming.read()).resolves.toMatchObject({
    value: new Uint8Array([7]),
    done: false
  });
  const old = mocks.windows[0].webContents;
  const invoke = (sender: typeof old, channel: string, ...args: unknown[]) =>
    (
      mocks.handlers.get(channel) as (
        event: unknown,
        ...args: unknown[]
      ) => Promise<unknown>
    )({ sender, senderFrame: sender.mainFrame }, ...args);
  const destination = path.join(root, "export.mp4");
  await writeFile(destination, "previous export");
  mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
  let closeSave!: () => void;
  const closeSaveBody = new Promise<void>((resolve) => {
    closeSave = resolve;
  });
  const saveBodyCanceled = vi.fn(() => closeSaveBody);
  transport.mockResolvedValueOnce(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel: saveBodyCanceled
      })
    )
  );
  const save = expect(
    invoke(old, IPC_CHANNELS.filesSaveCloudStorageObjectAs, { url: historical })
  ).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(async () =>
    expect(
      (await readdir(root)).some((entry) => entry.endsWith(".partial"))
    ).toBe(true)
  );
  const acknowledge = (sender: typeof old) =>
    mocks.events.get(IPC_CHANNELS.accountRetiredAck)?.({
      sender,
      senderFrame: sender.mainFrame
    });
  const choose = (sender: typeof old, mode: string) =>
    invoke(sender, IPC_CHANNELS.accountChooseMode, mode);
  let finishLoad!: () => void;
  mocks.nextLoad = () =>
    new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
  const offline = choose(old, "offline");
  await vi.waitFor(() =>
    expect(old.send).toHaveBeenCalledWith(IPC_CHANNELS.accountRetired)
  );
  acknowledge(old);
  try {
    await vi.waitFor(() => expect(saveBodyCanceled).toHaveBeenCalledOnce());
    expect(finishLoad).toBeUndefined();
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      appMode: "cloud"
    });
  } finally {
    closeSave();
  }
  let finishProtocolCancel!: () => void;
  const protocolClosed = new Promise<void>((resolve) => {
    finishProtocolCancel = resolve;
  });
  const canceled = vi.fn(() => protocolClosed);
  try {
    await save;
    expect(await readFile(destination, "utf8")).toBe("previous export");
    expect(
      (await readdir(root)).some((entry) => entry.endsWith(".partial"))
    ).toBe(false);
    deliver(new Response(new ReadableStream({ cancel: canceled })));
    await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce());
    expect(finishLoad).toBeUndefined();
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      appMode: "cloud"
    });
  } finally {
    finishProtocolCancel();
  }
  try {
    expect((await pending).status).toBe(404);
    await vi.waitFor(() => expect(streamingCanceled).toHaveBeenCalledOnce());
    await expect(streaming.read()).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(finishLoad).toBeUndefined();
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      appMode: "cloud"
    });
  } finally {
    closeStreaming();
  }
  await vi.waitFor(() => expect(finishLoad).toBeTypeOf("function"));
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
    appMode: "offline",
    libraryRoot: library
  });
  await expect(
    invoke(old, IPC_CHANNELS.cloudPrepareUpload, { assetId: "old" })
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    invoke(old, IPC_CHANNELS.cloudAssetInfo, "missing")
  ).resolves.toBeNull();
  finishLoad();
  await offline;
  const replacement = mocks.windows[0].webContents;
  const cloud = choose(replacement, "cloud");
  await vi.waitFor(() =>
    expect(replacement.send).toHaveBeenCalledWith(IPC_CHANNELS.accountRetired)
  );
  acknowledge(replacement);
  await cloud;
  await expect(
    invoke(old, IPC_CHANNELS.projectsMirrorCloud, { project: { id: "stale" } })
  ).rejects.toThrow();
  await expect(
    invoke(mocks.windows[0].webContents, IPC_CHANNELS.cloudAssetInfo, "missing")
  ).resolves.toBeNull();
  expect(open).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledTimes(3);
});

it.each([
  ["account choose", "late-output"],
  ["fal save", "late-output"],
  ["account choose", "partial-output"],
  ["fal save", "partial-output"],
  ["account choose", "partial-storage-initiation"],
  ["fal save", "partial-storage-initiation"]
] as const)(
  "blocks same-library %s until ordinary fal %s cleanup",
  async (action, delivery) => {
    const isUpload = delivery === "partial-storage-initiation";
    vi.resetModules();
    vi.clearAllMocks();
    mocks.appListeners.clear();
    mocks.handlers.clear();
    mocks.events.clear();
    mocks.protocols.clear();
    mocks.windows.length = 0;
    root = await mkdtemp(path.join(tmpdir(), "mago-ordinary-fal-drain-"));
    mocks.userData = path.join(root, "profile");
    const library = path.join(root, "library");
    await mkdir(mocks.userData);
    const settingsPath = path.join(mocks.userData, "settings.json");
    const providersPath = path.join(mocks.userData, "external-providers.json");
    const oldSettings = { libraryRoot: library, appMode: "cloud" };
    const oldFal = { keychainAccount: "synthetic-fal-before" };
    const newFal = { keychainAccount: "synthetic-fal-after" };
    await writeFile(settingsPath, JSON.stringify(oldSettings));
    await writeFile(providersPath, JSON.stringify({ fal: oldFal }));
    vi.stubEnv("MAGO_PACKAGED_SMOKE", "1");
    vi.stubEnv("MAGO_RENDERER_PORT", "47235");
    vi.stubEnv("MAGO_RENDERER_URL", "");
    vi.stubEnv(
      "MAGO_MIGRATIONS_PATH",
      path.join(process.cwd(), "desktop/main/database/migrations")
    );
    vi.stubGlobal("WebSocket", socket);
    for (const forbidden of [
      mocks.key,
      mocks.httpRequest,
      mocks.httpsRequest,
      mocks.netFetch
    ]) {
      forbidden.mockImplementation(() => {
        throw new Error(
          "Unexpected process, credential lookup, or network request"
        );
      });
    }
    const outputUrl = "https://ordinary-fal-output.invalid/audit-output.png";
    const storageUrl =
      "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
    let deliver!: (response: Response) => void;
    const headers = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let partialBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    const canceled = vi.fn(() => {
      partialBody = undefined;
      return cleanup;
    });
    const bytes = Uint8Array.of(7, 8, 9);
    const partialJson = new TextEncoder().encode('{"file_url":"https://');
    const pull = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            if (delivery !== "late-output") {
              partialBody = controller;
              controller.enqueue(isUpload ? partialJson : bytes);
            }
          },
          pull,
          cancel: canceled
        },
        { highWaterMark: 0 }
      ),
      isUpload ? { headers: { "Content-Type": "application/json" } } : undefined
    );
    const fetchFixture = vi.fn((url: string, init?: RequestInit) => {
      if (
        url !== (isUpload ? storageUrl : outputUrl) ||
        (init?.method ?? "GET") !== (isUpload ? "POST" : "GET")
      ) {
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }
      return isUpload ? Promise.resolve(response) : headers;
    });
    vi.stubGlobal("fetch", fetchFixture);
    const { IPC_CHANNELS } = await import("../shared/contracts.js");
    const { FAL_SHEET_MODEL } = await import("../shared/falSheetModel.js");
    const { DatabaseManager } = await import("./database/databaseManager.js");
    const {
      assets,
      externalRenderJobs,
      ordinaryFalJobs,
      projectAssets,
      projects,
      shots
    } = await import("./database/schema.js");
    const { ExternalRenderAssets } =
      await import("./providers/externalRenderAssets.js");
    const { ExternalRenderJobService } =
      await import("./providers/externalRenderJobService.js");
    const providerSettings =
      await import("./providers/externalProviderSettings.js");
    const readKey = vi.spyOn(providerSettings, "readExternalProviderKey");
    if (isUpload) readKey.mockResolvedValue("synthetic-fal-key");
    const jobId = "ordinary-fal-audit-output";
    const requestId = "accepted-fal-audit-request";
    const seed = new DatabaseManager();
    await seed.open(library);
    try {
      const db = seed.get();
      await db.insert(projects).values({ id: "project", name: "Fixture" });
      if (isUpload) {
        const sourcePath = path.join(library, "base.png");
        await writeFile(sourcePath, bytes);
        await db
          .insert(shots)
          .values({ id: "shot", projectId: "project", name: "Fixture" });
        await db
          .insert(assets)
          .values({ id: "base", name: "base", type: "image", sourcePath });
        await db
          .insert(projectAssets)
          .values({ projectId: "project", assetId: "base" });
      } else {
        await db.insert(ordinaryFalJobs).values({
          jobId,
          projectId: "project",
          shotId: "shot",
          model: FAL_SHEET_MODEL,
          kind: "image-edit",
          keychainAccount: oldFal.keychainAccount,
          inputDigest: "synthetic-input-digest",
          destination: {
            kind: "image-edit",
            frame: 0,
            canvas: { width: 2, height: 2 }
          },
          effectiveSettings: {}
        });
        await db.insert(externalRenderJobs).values({
          id: jobId,
          projectId: "project",
          provider: "fal",
          endpoint: "fal-ai/nano-banana-2/edit",
          kind: "image",
          keychainAccount: oldFal.keychainAccount,
          status: "OUTPUT_READY",
          requestId,
          requestJson: {},
          inputAssetIds: [],
          outputJson: { urls: [outputUrl] }
        });
      }
    } finally {
      seed.close();
    }
    const open = vi.spyOn(DatabaseManager.prototype, "open");
    const download = vi.spyOn(ExternalRenderAssets.prototype, "download");
    const submit = vi.spyOn(ExternalRenderJobService.prototype, "submit");
    const cancel = vi.spyOn(ExternalRenderJobService.prototype, "cancel");
    let transition: Promise<unknown> | undefined;
    let submission: Promise<unknown> | undefined;
    let acknowledge: (() => void) | undefined;
    try {
      await import("./application.js");
      await vi.waitFor(() =>
        expect(mocks.windows[0]?.webContents.mainFrame.url).toBeTruthy()
      );
      const sender = mocks.windows[0].webContents;
      const event = { sender, senderFrame: sender.mainFrame };
      const invoke = (channel: string, ...args: unknown[]) =>
        (
          mocks.handlers.get(channel) as (
            event: unknown,
            ...args: unknown[]
          ) => Promise<unknown>
        )(event, ...args);
      if (isUpload) {
        const expectedFal = await invoke(
          IPC_CHANNELS.externalProvidersGet,
          "fal"
        );
        submission = invoke(IPC_CHANNELS.ordinaryFalSubmit, {
          expectedFal,
          request: {
            id: "3a7ac26a-292e-4def-8cd8-842802d354b1",
            projectId: "project",
            shotId: "shot",
            kind: "image-edit",
            model: FAL_SHEET_MODEL,
            prompt: "Synthetic audit fixture",
            baseAssetId: "base",
            frame: 0,
            canvas: { width: 2, height: 2 }
          }
        });
        void submission.catch(() => {});
        // With zero read-ahead, pull can only run once the initial bytes
        // have been read and the parser has asked for more.
        await vi.waitFor(() => expect(pull).toHaveBeenCalled());
        expect(response.bodyUsed).toBe(true);
        expect(response.body?.locked).toBe(true);
        expect(readKey).toHaveBeenCalledExactlyOnceWith(
          oldFal.keychainAccount,
          expect.any(AbortSignal)
        );
      }
      await vi.waitFor(() => expect(fetchFixture).toHaveBeenCalledOnce());
      const signal = fetchFixture.mock.calls[0][1]!.signal!;
      expect(signal.aborted).toBe(false);
      let jobOutput: string | undefined;
      if (!isUpload) {
        const outputDir = path.join(library, "renders", "external");
        const jobs = await readdir(outputDir);
        expect(jobs).toHaveLength(1);
        const directory = path.join(outputDir, jobs[0]);
        jobOutput = directory;
        if (delivery === "partial-output") {
          deliver(response);
          await vi.waitFor(async () => {
            const files = await readdir(directory);
            expect(files).toEqual([
              expect.stringMatching(
                /^\.output-1\.mago-[a-f0-9-]{36}\.tmp\.png$/
              )
            ]);
            expect(await readFile(path.join(directory, files[0]))).toEqual(
              Buffer.from(bytes)
            );
          });
        } else {
          expect(await readdir(directory)).toEqual([]);
        }
      }
      expect(canceled).not.toHaveBeenCalled();
      transition =
        action === "account choose"
          ? invoke(IPC_CHANNELS.accountChooseMode, "offline")
          : invoke(IPC_CHANNELS.externalProvidersSave, "fal", newFal);
      // Attach both handlers immediately, including on a failing assertion.
      const settled = transition.then(
        () => "settled",
        () => "rejected"
      );
      if (action === "account choose") {
        acknowledge = () =>
          mocks.events.get(IPC_CHANNELS.accountRetiredAck)?.(event);
        await vi.waitFor(() =>
          expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.accountRetired)
        );
        acknowledge();
      }
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      if (delivery === "late-output") {
        expect(canceled).not.toHaveBeenCalled();
        // Deliver headers after abort, then hold the body's cancel promise.
        deliver(response);
      }
      await vi.waitFor(
        () =>
          expect(
            canceled,
            "reader cancel after profile abort"
          ).toHaveBeenCalledOnce(),
        { timeout: 1000 }
      );
      const progress = await Promise.race([
        settled,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("blocked"), 100)
        )
      ]);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(
        oldSettings
      );
      expect(JSON.parse(await readFile(providersPath, "utf8"))).toEqual({
        fal: oldFal
      });
      expect(progress).toBe("blocked");
      expect(mocks.windows[0].webContents).toBe(sender);
      finishCleanup();
      await transition;
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        ...oldSettings,
        appMode: action === "account choose" ? "offline" : "cloud"
      });
      expect(JSON.parse(await readFile(providersPath, "utf8"))).toEqual({
        fal: action === "fal save" ? newFal : oldFal
      });
      expect(open).toHaveBeenCalledExactlyOnceWith(library);
      if (isUpload) {
        await expect(submission).rejects.toThrow();
        // The only request is the free storage-initiation POST: no upload
        // PUT, paid queue POST, or remote cancel may cross the retirement.
        expect(
          fetchFixture.mock.calls.map(([url, init]) => [init?.method, url])
        ).toEqual([["POST", storageUrl]]);
      } else {
        expect(await readdir(jobOutput!)).toEqual([]);
        expect(submit).not.toHaveBeenCalled();
        expect(fetchFixture).toHaveBeenCalledExactlyOnceWith(outputUrl, {
          redirect: "error",
          signal
        });
      }
      expect(cancel).not.toHaveBeenCalled();
      for (const forbidden of [
        mocks.key,
        mocks.httpRequest,
        mocks.httpsRequest,
        mocks.netFetch,
        socket
      ]) {
        expect(forbidden).not.toHaveBeenCalled();
      }
    } finally {
      acknowledge?.();
      deliver(response);
      partialBody?.close();
      finishCleanup();
      await Promise.allSettled([
        transition,
        submission,
        ...submit.mock.results.map(({ value }) => value),
        ...download.mock.results.map(({ value }) => value)
      ]);
    }
    mocks.appListeners.get("before-quit")?.();
    mocks.appListeners.delete("before-quit");
    await seed.open(library);
    try {
      if (isUpload) {
        expect(await seed.get().select().from(externalRenderJobs)).toEqual([]);
        return;
      }
      expect(await seed.get().select().from(externalRenderJobs)).toMatchObject([
        {
          id: jobId,
          requestId,
          status: "OUTPUT_READY",
          outputJson: { urls: [outputUrl] }
        }
      ]);
      expect(await seed.get().select().from(ordinaryFalJobs)).toMatchObject([
        { jobId, placement: "PENDING", clipId: null }
      ]);
      expect(await seed.get().select().from(assets)).toEqual([]);
    } finally {
      seed.close();
    }
  }
);
