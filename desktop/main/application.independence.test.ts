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
  dialog: vi.fn()
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
    dialog: { showMessageBox: mocks.dialog, showMessageBoxSync: mocks.dialog },
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
    const { assets, clips, imageRenderJobs, projects, shots, tracks } =
      await import("./database/schema.js");
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
    expect(transport).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(mocks.netFetch).not.toHaveBeenCalled();
    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(mocks.key).not.toHaveBeenCalled();
    expect(mocks.exit).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.dialog).not.toHaveBeenCalled();
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
    } finally {
      seed.close();
    }
  }
);
