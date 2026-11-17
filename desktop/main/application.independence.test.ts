import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userData: "",
  appListeners: new Map<string, () => void>(),
  handlers: new Map<string, unknown>(),
  protocols: new Map<string, unknown>(),
  windows: [] as Array<{
    options: { webPreferences: { additionalArguments: string[] } };
    loadURL: ReturnType<typeof vi.fn>;
  }>,
  key: vi.fn(),
  netFetch: vi.fn(),
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
  exit: vi.fn(),
  quit: vi.fn(),
  dialog: vi.fn(),
  choose: vi.fn()
}));
vi.mock("electron", () => {
  const protocol = {
    handle: (scheme: string, handler: unknown) =>
      mocks.protocols.set(scheme, handler),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn()
  };
  const session = { defaultSession: { protocol } };
  class BrowserWindow {
    static getAllWindows = () => mocks.windows;
    static fromWebContents = () => mocks.windows[0];
    options;
    loadURL = vi.fn(async () => {});
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: session.defaultSession
    };
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
      on: vi.fn(),
      removeHandler: vi.fn()
    },
    session,
    protocol,
    net: { fetch: mocks.netFetch },
    nativeImage: {},
    dialog: {
      showMessageBox: mocks.dialog,
      showMessageBoxSync: mocks.dialog,
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
          senderFrame: { url: `https://${config.rendererHost}/` },
          sender: { isDestroyed: () => false, send: vi.fn() }
        },
        ...args
      );
    for (const [channel, args] of [
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
      ],
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
      [IPC_CHANNELS.projectsMirrorCloud, [{ project: { id: "asset" } }]],
      [
        IPC_CHANNELS.projectsCacheCloudAsset,
        [{ projectId: "asset", assetId: "asset", sourceUrl: historicalUrl }]
      ],
      [IPC_CHANNELS.scriptProjectsCacheMedia, ["asset", historicalUrl]],
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
