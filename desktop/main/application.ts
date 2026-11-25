import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  type WebContents
} from "electron";

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
import {
  createProfileComfyClient,
  drainComfyProfile
} from "./comfy/ComfyClient";
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
import {
  createAccountLifecycle,
  registerAccountHandlers
} from "./ipc/registerAccountHandlers";
import { registerCloudHandlers } from "./ipc/registerCloudHandlers";
import { registerCloudStorageHandlers } from "./ipc/registerCloudStorageHandlers";
import { registerComfyHandlers } from "./ipc/registerComfyHandlers";
import { registerExternalProviderHandlers } from "./ipc/registerExternalProviderHandlers";
import { registerImageRenderHandlers } from "./ipc/registerImageRenderHandlers";
import { registerLibraryHandlers } from "./ipc/registerLibraryHandlers";
import { registerLocalSetupHandlers } from "./ipc/registerLocalSetupHandlers";
import { registerMediaHandlers } from "./ipc/registerMediaHandlers";
import { registerOrdinaryFalHandlers } from "./ipc/registerOrdinaryFalHandlers";
import { registerProjectHandlers } from "./ipc/registerProjectHandlers";
import { registerScriptProjectHandlers } from "./ipc/registerScriptProjectHandlers";
import { registerVlmHandlers } from "./ipc/registerVlmHandlers";
import { TextModelBridge } from "./ipc/textModelBridge";
import { runBackgroundTask } from "./libraryHealth";
import { LibrarySettings } from "./librarySettings";
import { VideoFrameService } from "./media/videoFrameService";
import { openStartupLibrary } from "./openStartupLibrary";
import { OrdinaryFalService } from "./ordinaryFal/ordinaryFalService";
import { createExternalInferenceRouting } from "./providers/externalInferenceRouting";
import {
  createExternalProviderSettings,
  resolveProviderStartupMode
} from "./providers/externalProviderSettings";
import { ExternalRenderAssets } from "./providers/externalRenderAssets";
import { ExternalRenderJobRepository } from "./providers/externalRenderJobRepository";
import { ExternalRenderJobService } from "./providers/externalRenderJobService";
import { FalRenderProvider } from "./providers/falRenderProvider";
import { ProfileIoDrain } from "./providers/profileIoDrain";
import { ProfileLifetime } from "./providers/profileLifetime";
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
export const accountProfiles = new ProfileLifetime();
const accountIo = new ProfileIoDrain();
const falIo = new ProfileIoDrain();
const accountLifecycle = createAccountLifecycle(accountProfiles, {
  drainRetired: drainRetiredProfiles
});
const captureAccountProfile = (sender: WebContents): AbortSignal =>
  accountLifecycle.capture(sender);
const serializeProfileWrite = accountLifecycle.serialize;
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
  cloudStorageAccess,
  accountIo
);
const scriptProjectSnapshotRepository = new ScriptProjectSnapshotRepository(
  databaseManager,
  () => librarySettings.getLibraryRoot(),
  cloudStorageAccess,
  accountIo
);
const externalProviders = createExternalProviderSettings(
  () => app.getPath("userData"),
  {
    serializeWrite: serializeProfileWrite,
    drainRetiredInference: drainRetiredProfiles
  }
);
const comfyConfiguration = new ProfileLifetime();
let inferenceOrigin:
  | {
      account: AbortSignal;
      provider: AbortSignal;
      comfy: AbortSignal;
      signal: AbortSignal;
    }
  | undefined;
const retiredInference = new Set<AbortSignal>();
let drainSetup = async () => {};
let drainLauncher: (profile: AbortSignal) => Promise<void> = async () => {};
async function drainRetiredProfiles() {
  const retired = [...retiredInference];
  await Promise.all([
    drainSetup(),
    accountIo.drainRetired(),
    falIo.drainRetired(),
    ...retired.flatMap((profile) => [
      drainComfyProfile(profile),
      drainLauncher(profile),
      localScriptProjectService.drainInferenceProfile(profile),
      imageRenderService.drainInferenceProfile(profile)
    ])
  ]);
  for (const profile of retired) retiredInference.delete(profile);
}
const captureInferenceProfile = (sender?: WebContents): AbortSignal => {
  const account = sender
    ? captureAccountProfile(sender)
    : accountProfiles.capture();
  const provider = externalProviders.captureInferenceProfile();
  const comfy = comfyConfiguration.capture();
  if (
    !inferenceOrigin ||
    inferenceOrigin.account !== account ||
    inferenceOrigin.provider !== provider ||
    inferenceOrigin.comfy !== comfy
  ) {
    const signal = AbortSignal.any([account, provider, comfy]);
    signal.addEventListener(
      "abort",
      () => {
        retiredInference.add(signal);
      },
      { once: true }
    );
    inferenceOrigin = { account, provider, comfy, signal };
  }
  return inferenceOrigin.signal;
};
const commitComfyConfiguration = (
  sender: WebContents,
  origin: AbortSignal,
  write: () => Promise<void>
) =>
  serializeProfileWrite(async () => {
    origin.throwIfAborted();
    captureAccountProfile(sender);
    comfyConfiguration.suspend();
    try {
      await drainRetiredProfiles();
      await write();
    } finally {
      comfyConfiguration.resume();
    }
    return captureInferenceProfile(sender);
  });
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
  ),
  falIo
);
const ordinaryFalService = new OrdinaryFalService({
  databaseManager,
  getLibraryRoot: () => librarySettings.getLibraryRoot(),
  getFal: externalProviders.getFal,
  captureProfile: () =>
    AbortSignal.any([
      accountProfiles.capture(),
      externalProviders.captureInferenceProfile()
    ]),
  profileIo: falIo
});
const inference = createExternalInferenceRouting(
  externalProviders,
  generateComfyVision(librarySettings, captureInferenceProfile),
  (signal) =>
    probeComfyVision(librarySettings, signal, captureInferenceProfile())
);
const getExternalGenerator = inference.getGenerator;
const vlmService = new VlmService(
  projectRepository,
  inference.generateVision,
  inference.probeVision,
  inference.generateEnhancement,
  captureInferenceProfile
);
const assertLegacyInferenceAvailable =
  externalProviders.assertLegacyInferenceAvailable;
const getLegacyComfyEndpoint = async (origin = captureInferenceProfile()) => {
  origin.throwIfAborted();
  await assertLegacyInferenceAvailable();
  origin.throwIfAborted();
  const endpoint = await librarySettings.getComfyEndpoint();
  origin.throwIfAborted();
  return endpoint;
};
const getComfyScriptClient = async (
  caller?: AbortSignal,
  origin = captureInferenceProfile()
) => {
  caller?.throwIfAborted();
  const endpoint = await getLegacyComfyEndpoint(origin);
  const textModel = await librarySettings.getScriptTextModel();
  origin.throwIfAborted();
  caller?.throwIfAborted();
  return new ComfyScriptProjectClient(
    endpoint,
    textModel,
    createProfileComfyClient(endpoint, origin, caller)
  );
};
const PROMPT_ADAPTATION_MAX_TOKENS = 4600;
const SCRIPT_CHAT_MAX_TOKENS = 16_000;
const runExternalScriptText = async (
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  const generate = await getExternalGenerator("text", signal);
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
const describeImageLater = (assetId: string, origin?: AbortSignal) =>
  vlmService.describeAssetLater(assetId, origin);
const captureImageDescriptionSession = () => vlmService.libraryWork.signal;
const i2vPromptAdapter = new LocalI2vPromptAdapter({
  getAsset: (assetId) =>
    vlmService.libraryWork.boundary(() => projectRepository.getAsset(assetId)),
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
    if (external) return external.text;
    const client = await getComfyScriptClient(signal);
    signal?.throwIfAborted();
    return client.runPromptAdaptation(prompt, () => signal?.aborted === true);
  }
});
const textModelBridge = new TextModelBridge(captureInferenceProfile);
const runLegacyTextModel: typeof textModelBridge.run = async (
  operation,
  body,
  isCancelled,
  caller
) => {
  caller?.throwIfAborted();
  const profile = captureInferenceProfile();
  const signal = caller ? AbortSignal.any([caller, profile]) : profile;
  await assertLegacyInferenceAvailable();
  signal.throwIfAborted();
  return textModelBridge.run(operation, body, isCancelled, signal);
};
const localScriptProjectService = new LocalScriptProjectService(
  projectRepository,
  scriptProjectSnapshotRepository,
  getLegacyComfyEndpoint,
  () => librarySettings.getScriptTextModel(),
  (sourcePath, kind, signal, profile) =>
    vlmService.describeEntityImage(
      sourcePath,
      kind,
      undefined,
      signal,
      profile
    ),
  runLegacyTextModel,
  (input, signal) => vlmService.evaluateShotVideo(input, signal),
  (signal) => getExternalGenerator("text", signal),
  externalRenderJobService,
  async (sourcePath, kind, signal, profile) => {
    signal?.throwIfAborted();
    const generate = await getExternalGenerator("vision", signal);
    signal?.throwIfAborted();
    if (!generate)
      throw new Error(
        "Configure an external vision provider to describe fal images"
      );
    return vlmService.describeEntityImage(
      sourcePath,
      kind,
      generate,
      signal,
      profile
    );
  },
  async () => (await externalProviders.getFal())?.generationSettings,
  captureInferenceProfile,
  accountIo
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
      undefined,
      signal
    );
    if (cloud) return { content: String(cloud.content), model: "cloud" };
    signal?.throwIfAborted();
    return (await getComfyScriptClient(signal)).runScriptChat(
      prompt,
      () => signal?.aborted === true
    );
  }
);
const cloudLinkRepository = new CloudLinkRepository(databaseManager);
const uploadService = new UploadService(
  () => librarySettings.getLibraryRoot(),
  accountIo
);
const cloudRenderJobRepository = new CloudRenderJobRepository(databaseManager);
const cloudRenderSubmitService = new CloudRenderSubmitService(
  databaseManager,
  () => librarySettings.getLibraryRoot(),
  describeImageLater,
  undefined,
  captureImageDescriptionSession
);
const imageRenderService = new ImageRenderService(
  databaseManager,
  () => librarySettings.getLibraryRoot(),
  getLegacyComfyEndpoint,
  describeImageLater,
  assertLegacyInferenceAvailable,
  captureImageDescriptionSession,
  captureInferenceProfile
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
  try {
    captureAccountProfile(deepLinkTarget.webContents);
  } catch {
    // Do not forward an auth callback during account replacement.
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
  accountLifecycle.bindWindow(window.webContents);

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
    accountLifecycle.retire();
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
  // The caller holds the profile write queue, including the fallback dialog.
  windowsBeingCreated += 1;
  try {
    const appMode = await resolveProviderStartupMode(
      await librarySettings.getAppMode(),
      externalProviders
    );
    try {
      return await createWindowOnce(appMode);
    } catch (error) {
      accountLifecycle.retire();
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
      return await accountLifecycle.replace(
        () => librarySettings.setAppMode("offline"),
        () => {
          resumeStartupTimeout();
          return createWindowOnce("offline");
        }
      );
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
      librarySettings,
      videoFrameService.libraryWork,
      () => accountProfiles.capture(),
      accountIo
    );
    ({ drainLaunchCleanup: drainLauncher } = registerComfyHandlers(
      librarySettings,
      assertLegacyInferenceAvailable,
      {
        captureInferenceProfile,
        commitComfyConfiguration,
        serializeProfileWrite
      }
    ));
    registerExternalProviderHandlers(externalProviders, {
      captureAccountProfile
    });
    textModelBridge.register();
    registerCloudHandlers({
      links: cloudLinkRepository,
      uploads: uploadService,
      repository: projectRepository,
      renderJobs: cloudRenderJobRepository,
      renderSubmits: cloudRenderSubmitService,
      databaseManager,
      getLibraryRoot: () => librarySettings.getLibraryRoot(),
      settings: librarySettings,
      captureImageDescriptionSession,
      captureAccountProfile,
      profileIoDrain: accountIo
    });
    registerImageRenderHandlers(
      imageRenderService,
      cloudRenderJobRepository,
      captureInferenceProfile
    );
    registerMediaHandlers(videoFrameService);
    stopVlmRequests = registerVlmHandlers(
      vlmService,
      i2vPromptAdapter,
      async () => !!(await externalProviders.get("text")),
      captureInferenceProfile
    );

    ({ drainRetired: drainSetup } = registerLocalSetupHandlers({
      settings: librarySettings,
      assertInferenceAvailable: assertLegacyInferenceAvailable,
      captureProfile: captureInferenceProfile
    }));

    const libraryLifecycle = registerLibraryHandlers({
      settings: librarySettings,
      databaseManager,
      repository: projectRepository,
      mediaWork: videoFrameService.libraryWork,
      beforeLibraryChange: async () => {
        await Promise.all([
          localScriptProjectService.suspendPlans(),
          externalRenderJobService.suspend(),
          ordinaryFalService.suspend(),
          localScriptChatService.suspend(),
          localScriptProjectService.suspendMetrics(),
          localScriptProjectService.suspendDescriptions(),
          vlmService.suspend(),
          videoFrameService.libraryWork.suspend(),
          cloudRenderSubmitService.libraryWork.suspend(),
          uploadService.libraryWork.suspend(),
          cloudLinkRepository.libraryWork.suspend(),
          cloudRenderJobRepository.libraryWork.suspend(),
          cloudProjectMirrorRepository.libraryWork.suspend(),
          scriptProjectSnapshotRepository.libraryWork.suspend(),
          imageRenderService.suspend()
        ]);
      },
      afterLibraryChange: () => {
        externalRenderJobService.reset();
        ordinaryFalService.reset();
        localScriptProjectService.resetPlans();
        localScriptChatService.reset();
        localScriptProjectService.resetMetrics();
        localScriptProjectService.resetDescriptions();
        vlmService.reset();
        videoFrameService.libraryWork.reset();
        cloudRenderSubmitService.libraryWork.reset();
        uploadService.libraryWork.reset();
        cloudLinkRepository.libraryWork.reset();
        cloudRenderJobRepository.libraryWork.reset();
        cloudProjectMirrorRepository.libraryWork.reset();
        scriptProjectSnapshotRepository.libraryWork.reset();
        imageRenderService.reset();
      }
    });
    registerCloudStorageHandlers(librarySettings, {
      libraryWork: videoFrameService.libraryWork,
      assertLibraryAvailable: () => libraryLifecycle.assertAvailable(),
      captureAccountProfile,
      profileIoDrain: accountIo
    });
    registerProjectHandlers(
      projectRepository,
      cloudProjectMirrorRepository,
      databaseManager,
      librarySettings,
      describeImageLater,
      vlmService.libraryWork,
      videoFrameService.libraryWork,
      captureAccountProfile,
      () => libraryLifecycle.assertAvailable(),
      accountIo
    );
    registerScriptProjectHandlers({
      service: localScriptProjectService,
      chat: localScriptChatService,
      databaseManager,
      captureAccountProfile,
      captureInferenceProfile,
      profileIo: accountIo,
      settings: librarySettings
    });
    registerAccountHandlers({
      settings: librarySettings,
      lifecycle: accountLifecycle,
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
    registerOrdinaryFalHandlers(ordinaryFalService, captureAccountProfile);
    await serializeProfileWrite(createWindow);
    ordinaryFalService.start();
    imageRenderService.startWithRecovery();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      void serializeProfileWrite(async () => {
        if (BrowserWindow.getAllWindows().length === 0) await createWindow();
      }).catch(failStartup);
    });
  })
  .catch(failStartup);

app.on("window-all-closed", () => {
  // A failed cloud window is destroyed before its offline replacement opens.
  if (windowsBeingCreated > 0) return;
  accountLifecycle.retire();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  accountLifecycle.retire();
  localScriptProjectService.stopPlans();
  externalRenderJobService.stop();
  ordinaryFalService.stop();
  stopVlmRequests();
  vlmService.stop();
  videoFrameService.libraryWork.stop();
  cloudRenderSubmitService.libraryWork.stop();
  uploadService.libraryWork.stop();
  cloudLinkRepository.libraryWork.stop();
  cloudRenderJobRepository.libraryWork.stop();
  cloudProjectMirrorRepository.libraryWork.stop();
  scriptProjectSnapshotRepository.libraryWork.stop();
  localScriptChatService.stop();
  localScriptProjectService.stopMetrics();
  localScriptProjectService.stopDescriptions();
  void rendererOriginPromise?.then((origin) => origin.close());
  imageRenderService.stop();
  imageRenderService.libraryWork.stop();
  closeAllComfyProgressMonitors();
  databaseManager.close();
});
