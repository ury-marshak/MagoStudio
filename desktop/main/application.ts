import path from "node:path";

import { app, BrowserWindow, dialog, session, shell } from "electron";

import {
  inWindowNavigationHosts,
  resolveCloudConfig
} from "../shared/cloudConfig";
import { IPC_CHANNELS, type MagoAppMode } from "../shared/contracts";

import { CloudLinkRepository } from "./cloud/cloudLinkRepository";
import { CloudRenderJobRepository } from "./cloud/cloudRenderJobRepository";
import { CloudRenderSubmitService } from "./cloud/cloudRenderSubmitService";
import { requireCloudAccount } from "./cloud/requireCloudAccount";
import { UploadService } from "./cloud/uploadService";
import { closeAllComfyProgressMonitors } from "./comfy/comfyProgressMonitors";
import { CloudProjectMirrorRepository } from "./database/cloudProjectMirrorRepository";
import { DatabaseManager } from "./database/databaseManager";
import { ProjectRepository } from "./database/projectRepository";
import { ScriptChatMessageRepository } from "./database/scriptChatMessageRepository";
import { ScriptProjectSnapshotRepository } from "./database/scriptProjectSnapshotRepository";
import {
  DeepLink,
  listenForDeepLinks,
  registerDeepLinkScheme
} from "./deepLink";
import { ImageRenderService } from "./imageRenders/imageRenderService";
import { registerAccountHandlers } from "./ipc/registerAccountHandlers";
import { registerCloudHandlers } from "./ipc/registerCloudHandlers";
import { registerCloudStorageHandlers } from "./ipc/registerCloudStorageHandlers";
import { registerComfyHandlers } from "./ipc/registerComfyHandlers";
import { registerExternalProviderHandlers } from "./ipc/registerExternalProviderHandlers";
import { registerImageRenderHandlers } from "./ipc/registerImageRenderHandlers";
import { registerLibraryHandlers } from "./ipc/registerLibraryHandlers";
import { registerLocalSetupHandlers } from "./ipc/registerLocalSetupHandlers";
import { registerMediaHandlers } from "./ipc/registerMediaHandlers";
import { registerProjectHandlers } from "./ipc/registerProjectHandlers";
import { registerScriptProjectHandlers } from "./ipc/registerScriptProjectHandlers";
import { registerVlmHandlers } from "./ipc/registerVlmHandlers";
import { TextModelBridge } from "./ipc/textModelBridge";
import { runBackgroundTask } from "./libraryHealth";
import { LibrarySettings } from "./librarySettings";
import { VideoFrameService } from "./media/videoFrameService";
import { openStartupLibrary } from "./openStartupLibrary";
import { createExternalInferenceRouting } from "./providers/externalInferenceRouting";
import {
  createExternalProviderSettings,
  resolveProviderStartupMode
} from "./providers/externalProviderSettings";
import { ExternalRenderAssets } from "./providers/externalRenderAssets";
import { ExternalRenderJobRepository } from "./providers/externalRenderJobRepository";
import { ExternalRenderJobService } from "./providers/externalRenderJobService";
import { FalRenderProvider } from "./providers/falRenderProvider";
import { installOfflineRenderer } from "./renderer/offlineRenderer";
import {
  ensureRendererCertificate,
  installHostResolverRule,
  pinRendererCertificate,
  RendererOrigin,
  rendererPort,
  startRendererOrigin
} from "./renderer/rendererOrigin";
import { registerMediaProtocol } from "./rendererProtocol";
import { ComfyScriptProjectClient } from "./scriptProjects/comfyScriptProjectClient";
import { LocalScriptChatService } from "./scriptProjects/localScriptChatService";
import { LocalScriptProjectService } from "./scriptProjects/localScriptProjectService";
import {
  failStartup,
  logStartup,
  pauseStartupTimeout,
  resumeStartupTimeout,
  startupComplete
} from "./startupDiagnostics";
import {
  generateComfyVision,
  probeComfyVision
} from "./vlm/comfyVisionProvider";
import { LocalI2vPromptAdapter } from "./vlm/localI2vPromptAdapter";
import { VlmService } from "./vlm/vlmService";

const databaseManager = new DatabaseManager();
const librarySettings = new LibrarySettings();
const cloudStorageAccess = {
  allowedHosts: resolveCloudConfig().cloudStorageHosts,
  assertAccess: () => requireCloudAccount(librarySettings)
};
const projectRepository = new ProjectRepository(databaseManager, () =>
  librarySettings.getLibraryRoot()
);
const cloudProjectMirrorRepository = new CloudProjectMirrorRepository(
  databaseManager,
  () => librarySettings.getLibraryRoot(),
  cloudStorageAccess
);
const scriptProjectSnapshotRepository = new ScriptProjectSnapshotRepository(
  databaseManager,
  () => librarySettings.getLibraryRoot(),
  cloudStorageAccess
);
const externalProviders = createExternalProviderSettings(() =>
  app.getPath("userData")
);
const externalRenderJobRepository = new ExternalRenderJobRepository(
  databaseManager
);
const externalRenderJobService = new ExternalRenderJobService(
  externalRenderJobRepository,
  new Map([["fal", new FalRenderProvider(externalProviders.getFal)]]),
  new ExternalRenderAssets(
    databaseManager,
    () => librarySettings.getLibraryRoot(),
    (assetId, projectId) =>
      scriptProjectSnapshotRepository.resolveMediaPath(assetId, projectId)
  )
);
const inference = createExternalInferenceRouting(
  externalProviders,
  generateComfyVision(librarySettings),
  () => probeComfyVision(librarySettings)
);
const getExternalGenerator = inference.getGenerator;
const vlmService = new VlmService(
  projectRepository,
  inference.generateVision,
  inference.probeVision,
  inference.generateEnhancement
);
const assertLegacyInferenceAvailable =
  externalProviders.assertLegacyInferenceAvailable;
const getLegacyComfyEndpoint = async () => {
  await assertLegacyInferenceAvailable();
  return librarySettings.getComfyEndpoint();
};
const getComfyScriptClient = async () =>
  new ComfyScriptProjectClient(
    await getLegacyComfyEndpoint(),
    await librarySettings.getScriptTextModel()
  );
const PROMPT_ADAPTATION_MAX_TOKENS = 4600;
const SCRIPT_CHAT_MAX_TOKENS = 16_000;
const runExternalScriptText = async (
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  const generate = await getExternalGenerator("text");
  signal?.throwIfAborted();
  return generate?.({
    signal,
    systemPrompt:
      "Return only valid JSON. The final answer's first character must be { and its last must be }.",
    userPrompt: prompt,
    maxTokens,
    temperature: 0.1
  });
};
// Every image that lands in the library gets a description, the way
// The backend describes every upload and render.
const describeImageLater = (assetId: string) =>
  vlmService.describeAssetLater(assetId);
const i2vPromptAdapter = new LocalI2vPromptAdapter({
  getAsset: (assetId) => projectRepository.getAsset(assetId),
  describeImage: (assetId, signal) =>
    vlmService.describeImageAsset(assetId, signal),
  captionVideo: async (assetId, signal) =>
    (await vlmService.captionAsset(assetId, signal)).prompt,
  runTextPrompt: async (prompt, signal) => {
    const external = await runExternalScriptText(
      prompt,
      PROMPT_ADAPTATION_MAX_TOKENS,
      signal
    );
    return external
      ? external.text
      : (await getComfyScriptClient()).runPromptAdaptation(
          prompt,
          () => signal?.aborted === true
        );
  }
});
const textModelBridge = new TextModelBridge();
const runLegacyTextModel: typeof textModelBridge.run = async (...args) => {
  await assertLegacyInferenceAvailable();
  return textModelBridge.run(...args);
};
const localScriptProjectService = new LocalScriptProjectService(
  projectRepository,
  scriptProjectSnapshotRepository,
  getLegacyComfyEndpoint,
  () => librarySettings.getScriptTextModel(),
  (sourcePath, kind, signal) =>
    vlmService.describeEntityImage(sourcePath, kind, undefined, signal),
  runLegacyTextModel,
  (input, signal) => vlmService.evaluateShotVideo(input, signal),
  () => getExternalGenerator("text"),
  externalRenderJobService,
  async (sourcePath, kind, signal) => {
    signal?.throwIfAborted();
    const generate = await getExternalGenerator("vision");
    signal?.throwIfAborted();
    if (!generate)
      throw new Error(
        "Configure an external vision provider to describe fal images"
      );
    return vlmService.describeEntityImage(sourcePath, kind, generate, signal);
  },
  async () => (await externalProviders.getFal())?.generationSettings
);
const localScriptChatService = new LocalScriptChatService(
  new ScriptChatMessageRepository(databaseManager),
  (projectId) => localScriptProjectService.assertLocalProject(projectId),
  async (prompt, signal) => {
    const external = await runExternalScriptText(
      prompt,
      SCRIPT_CHAT_MAX_TOKENS,
      signal
    );
    if (external) return { content: external.text, model: external.model };
    signal?.throwIfAborted();
    const cloud = await runLegacyTextModel(
      "chat",
      { prompt },
      () => signal?.aborted === true
    );
    if (cloud) return { content: String(cloud.content), model: "cloud" };
    signal?.throwIfAborted();
    return (await getComfyScriptClient()).runScriptChat(
      prompt,
      () => signal?.aborted === true
    );
  }
);
const cloudLinkRepository = new CloudLinkRepository(databaseManager);
const uploadService = new UploadService(() => librarySettings.getLibraryRoot());
const cloudRenderJobRepository = new CloudRenderJobRepository(databaseManager);
const cloudRenderSubmitService = new CloudRenderSubmitService(
  databaseManager,
  () => librarySettings.getLibraryRoot(),
  describeImageLater
);
const imageRenderService = new ImageRenderService(
  databaseManager,
  () => librarySettings.getLibraryRoot(),
  getLegacyComfyEndpoint,
  describeImageLater,
  assertLegacyInferenceAvailable
);
const videoFrameService = new VideoFrameService(projectRepository);
const usesPackagedRenderer =
  app.isPackaged || process.env.MAGO_PACKAGED_SMOKE === "1";
const developmentRendererUrl = process.env.MAGO_RENDERER_URL;
const cloudConfig = resolveCloudConfig();
const RENDERER_LOAD_TIMEOUT_MS = 15_000;
let windowsBeingCreated = 0;
let stopVlmRequests = () => {};

/**
 * Bring up the https origin the renderer is served from, and point its hostname
 * at the loopback listener.
 *
 * The resolver rule is installed synchronously, at module load: Chromium reads
 * that switch while starting its network service, so installing it after any
 * `await` is too late and the hostname fails to resolve. That is why the port is
 * fixed rather than ephemeral — it has to be known before the listener binds.
 */
const port = rendererPort();
if (usesPackagedRenderer || developmentRendererUrl) {
  installHostResolverRule({ host: cloudConfig.rendererHost, port });
}
let rendererOriginPromise: Promise<RendererOrigin> | null = null;
let offlineRendererInstalled = false;
const getRendererOrigin = (): Promise<RendererOrigin> | null => {
  if (!usesPackagedRenderer && !developmentRendererUrl) return null;
  // Offline startup must never wait for a certificate or a listening socket.
  rendererOriginPromise ??= (async () => {
    const certificate = await ensureRendererCertificate(
      cloudConfig.rendererHost
    );
    return startRendererOrigin({
      ...(developmentRendererUrl
        ? { upstreamUrl: developmentRendererUrl }
        : { rendererRoot: path.join(app.getAppPath(), "out") }),
      certificate,
      port,
      config: cloudConfig
    });
  })().catch((error: unknown) => {
    rendererOriginPromise = null;
    throw error;
  });
  return rendererOriginPromise;
};

registerDeepLinkScheme();

const pendingDeepLinks: DeepLink[] = [];
let deepLinkTarget: BrowserWindow | null = null;

const deliverDeepLink = (link: DeepLink): void => {
  if (!deepLinkTarget || deepLinkTarget.isDestroyed()) {
    pendingDeepLinks.push(link);
    return;
  }
  deepLinkTarget.webContents.send(IPC_CHANNELS.accountDeepLink, link);
  if (deepLinkTarget.isMinimized()) deepLinkTarget.restore();
  deepLinkTarget.focus();
};

const isSingleInstance = listenForDeepLinks(deliverDeepLink);
if (!isSingleInstance) app.quit();
app.on("second-instance", () => {
  if (!deepLinkTarget || deepLinkTarget.isDestroyed()) return;
  if (deepLinkTarget.isMinimized()) deepLinkTarget.restore();
  deepLinkTarget.show();
  deepLinkTarget.focus();
});

const createWindowOnce = async (
  appMode: MagoAppMode
): Promise<BrowserWindow> => {
  logStartup("Waiting for renderer origin");
  const useOfflineRenderer = usesPackagedRenderer && appMode === "offline";
  if (useOfflineRenderer && !offlineRendererInstalled) {
    installOfflineRenderer(
      session.defaultSession,
      path.join(app.getAppPath(), "out"),
      cloudConfig
    );
    offlineRendererInstalled = true;
    logStartup(
      "Offline renderer: serving bundled files directly (no TLS listener)"
    );
  } else if (!useOfflineRenderer && offlineRendererInstalled) {
    session.defaultSession.protocol.unhandle("https");
    offlineRendererInstalled = false;
  }
  const origin = useOfflineRenderer ? null : await getRendererOrigin();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0c0c0e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [`--mago-app-mode=${appMode}`]
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === "https:") void shell.openExternal(url);
    } catch {
      // Invalid and non-HTTPS URLs remain blocked.
    }
    return { action: "deny" };
  });
  const allowedHosts = new Set(inWindowNavigationHosts(cloudConfig));
  window.webContents.on("will-navigate", (event, url) => {
    const isDevelopmentApp =
      !app.isPackaged &&
      (url.startsWith("http://127.0.0.1:") ||
        url.startsWith("http://localhost:"));
    if (isDevelopmentApp) return;

    let target: URL | null = null;
    try {
      target = new URL(url);
    } catch {
      target = null;
    }
    // The sign-in chain -- our origin, Clerk's frontend API, the OAuth provider
    // -- must navigate in place, because the session cookie it produces has to
    // land in this window's cookie jar. Everything else opens in the user's real
    // browser: Stripe checkout, documentation, any stray link.
    if (target?.protocol === "https:" && allowedHosts.has(target.host)) return;

    event.preventDefault();
    if (target?.protocol === "https:") void shell.openExternal(target.href);
  });

  if (origin) {
    pinRendererCertificate(window.webContents.session, origin);
  }

  window.webContents.on("console-message", (details) => {
    if (details.level === "error") {
      logStartup(
        `Renderer error: ${details.message} (${details.sourceId}:${details.lineNumber})`
      );
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    failStartup(
      new Error(`Renderer exited: ${details.reason} (${details.exitCode})`)
    );
  });
  window.webContents.on("unresponsive", () => {
    logStartup("Renderer is unresponsive");
    window.show();
  });
  window.once("ready-to-show", () => {
    window.show();
    startupComplete();
  });
  logStartup("Loading application window");
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      window.loadURL(
        useOfflineRenderer
          ? `https://${cloudConfig.rendererHost}/`
          : origin?.url || "about:blank"
      ),
      new Promise<never>((_resolve, reject) => {
        // Next's development server can need longer for its first compilation.
        if (!usesPackagedRenderer) return;
        loadTimer = setTimeout(() => {
          reject(
            new Error("The application window did not load within 15 seconds.")
          );
        }, RENDERER_LOAD_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    window.destroy();
    throw error;
  } finally {
    clearTimeout(loadTimer);
  }

  deepLinkTarget = window;
  while (pendingDeepLinks.length > 0) {
    const link = pendingDeepLinks.shift();
    if (link) deliverDeepLink(link);
  }
  return window;
};

const createWindow = async (): Promise<BrowserWindow> => {
  windowsBeingCreated += 1;
  try {
    const appMode = await resolveProviderStartupMode(
      await librarySettings.getAppMode(),
      externalProviders
    );
    try {
      return await createWindowOnce(appMode);
    } catch (error) {
      if (!usesPackagedRenderer || appMode === "offline") throw error;
      logStartup(`Cloud renderer startup failed: ${String(error)}`);
      pauseStartupTimeout();
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "Mago Studio could not open cloud sign-in",
        message: "You can continue working offline.",
        detail:
          "Cloud sign-in could not start. Your local library is available in offline mode. You can try signing in again later.",
        buttons: ["Work offline", "Show error"],
        defaultId: 0,
        cancelId: 1
      });
      if (response !== 0) throw error;
      await librarySettings.setAppMode("offline");
      resumeStartupTimeout();
      return await createWindowOnce("offline");
    }
  } finally {
    windowsBeingCreated -= 1;
  }
};

void app
  .whenReady()
  .then(async () => {
    logStartup("Electron ready; registering services");
    registerMediaProtocol(
      projectRepository,
      scriptProjectSnapshotRepository,
      librarySettings
    );
    registerComfyHandlers(librarySettings, assertLegacyInferenceAvailable);
    registerExternalProviderHandlers(externalProviders);
    textModelBridge.register();
    registerCloudHandlers({
      links: cloudLinkRepository,
      uploads: uploadService,
      repository: projectRepository,
      renderJobs: cloudRenderJobRepository,
      renderSubmits: cloudRenderSubmitService,
      databaseManager,
      getLibraryRoot: () => librarySettings.getLibraryRoot(),
      settings: librarySettings
    });
    registerImageRenderHandlers(imageRenderService, cloudRenderJobRepository);
    registerMediaHandlers(videoFrameService);
    registerCloudStorageHandlers(librarySettings);
    stopVlmRequests = registerVlmHandlers(
      vlmService,
      i2vPromptAdapter,
      async () => !!(await externalProviders.get("text"))
    );

    registerLocalSetupHandlers({
      settings: librarySettings,
      assertInferenceAvailable: assertLegacyInferenceAvailable
    });

    registerLibraryHandlers({
      settings: librarySettings,
      databaseManager,
      repository: projectRepository,
      beforeLibraryChange: async () => {
        await Promise.all([
          localScriptProjectService.suspendPlans(),
          externalRenderJobService.suspend(),
          localScriptChatService.suspend(),
          localScriptProjectService.suspendMetrics(),
          localScriptProjectService.suspendDescriptions()
        ]);
      },
      afterLibraryChange: () => {
        externalRenderJobService.reset();
        localScriptProjectService.resetPlans();
        localScriptChatService.reset();
        localScriptProjectService.resetMetrics();
        localScriptProjectService.resetDescriptions();
      }
    });
    registerProjectHandlers(
      projectRepository,
      cloudProjectMirrorRepository,
      databaseManager,
      librarySettings,
      describeImageLater
    );
    registerScriptProjectHandlers({
      service: localScriptProjectService,
      chat: localScriptChatService,
      databaseManager,
      settings: librarySettings
    });
    registerAccountHandlers({
      settings: librarySettings,
      rebuildWindow: async () => {
        const existing = BrowserWindow.getAllWindows();
        const replacement = await createWindow();
        for (const window of existing) {
          if (window !== replacement) window.destroy();
        }
      }
    });

    if (!(await openStartupLibrary(databaseManager, librarySettings))) {
      app.quit();
      return;
    }
    await runBackgroundTask(
      "Interrupted external render submission recovery",
      () => externalRenderJobRepository.markInterruptedSubmissions()
    );
    await runBackgroundTask("External render plan recovery", () =>
      localScriptProjectService.recoverExternalRenderPlans()
    );
    await createWindow();
    void runBackgroundTask("Interrupted render recovery", async () => {
      await imageRenderService.reconcileInterruptedRenders();
      imageRenderService.start();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0)
        void createWindow().catch(failStartup);
    });
  })
  .catch(failStartup);

app.on("window-all-closed", () => {
  // A failed cloud window is destroyed before its offline replacement opens.
  if (windowsBeingCreated > 0) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  localScriptProjectService.stopPlans();
  externalRenderJobService.stop();
  stopVlmRequests();
  vlmService.stop();
  localScriptChatService.stop();
  localScriptProjectService.stopMetrics();
  localScriptProjectService.stopDescriptions();
  void rendererOriginPromise?.then((origin) => origin.close());
  imageRenderService.stop();
  closeAllComfyProgressMonitors();
  databaseManager.close();
});
