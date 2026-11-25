import path from "node:path";

import {
  app,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents
} from "electron";

import {
  IPC_CHANNELS,
  LOCAL_SCRIPT_TEXT_MODELS,
  LOCAL_TEXT_MODEL_PROVIDERS,
  LOCAL_VLM_BACKENDS,
  type ComfySettings,
  type ComfyStatus,
  type LocalScriptTextModel,
  type LocalTextModelProvider,
  type LocalVlmBackend
} from "../../shared/contracts";
import { createProfileComfyClient } from "../comfy/ComfyClient";
import { ComfyLauncher } from "../comfy/ComfyLauncher";
import { normalizeComfyEndpoint } from "../comfy/normalizeComfyEndpoint";
import { readComfyRestartStatus } from "../comfy/readComfyRestartStatus";
import { restartComfy } from "../comfy/restartComfy";
import {
  isComfyRenderModelName,
  probeComfyRenderModel
} from "../imageRenders/comfyModelValidation";
import { ComfyQwenClient } from "../imageRenders/comfyQwenClient";
import { LibrarySettings } from "../librarySettings";
import {
  evaluateScriptSetup,
  probeScriptSetup
} from "../localSetup/probeScriptSetup";
import { addSetupDestinations } from "../localSetup/setupDestinations";
import { ProfileLifetime } from "../providers/profileLifetime";

import { requireTrustedSender } from "./trustedSender";

const check = async (
  settings: ComfySettings,
  signal?: AbortSignal
): Promise<ComfyStatus> => {
  signal?.throwIfAborted();
  const { endpoint } = settings;
  try {
    const normalized = normalizeComfyEndpoint(endpoint);
    await new ComfyQwenClient(
      normalized,
      undefined,
      signal ? createProfileComfyClient(normalized, signal) : undefined
    ).validate();
    signal?.throwIfAborted();
    return {
      ...settings,
      endpoint: normalized,
      configured: true,
      available: true,
      message: null
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...settings,
      configured: Boolean(endpoint.trim()),
      available: false,
      message: error instanceof Error ? error.message : "ComfyUI is unavailable"
    };
  }
};

const readComfySettings = async (
  settings: LibrarySettings,
  signal?: AbortSignal
): Promise<ComfySettings> => {
  signal?.throwIfAborted();
  const endpoint = await settings.getComfyEndpoint();
  signal?.throwIfAborted();
  const vlmBackend = await settings.getVlmBackend();
  signal?.throwIfAborted();
  const scriptTextModel = await settings.getScriptTextModel();
  signal?.throwIfAborted();
  const textModelProvider = await settings.getTextModelProvider();
  signal?.throwIfAborted();
  return { endpoint, vlmBackend, scriptTextModel, textModelProvider };
};

type ComfyHandlerOwnership = {
  captureInferenceProfile?: (sender: WebContents) => AbortSignal;
  commitComfyConfiguration?: (
    sender: WebContents,
    origin: AbortSignal,
    write: () => Promise<void>
  ) => Promise<AbortSignal>;
  serializeProfileWrite?: <T>(operation: () => Promise<T>) => Promise<T>;
};

export const registerComfyHandlers = (
  settings: LibrarySettings,
  assertInferenceAvailable: () => Promise<void> = async () => {},
  {
    captureInferenceProfile,
    commitComfyConfiguration,
    serializeProfileWrite
  }: ComfyHandlerOwnership = {}
) => {
  const launcher = new ComfyLauncher(
    settings,
    path.join(app.getPath("userData"), "logs", "comfyui.log")
  );
  const configuration = new ProfileLifetime();
  let previousWrite = Promise.resolve();
  const serializeWrite =
    serializeProfileWrite ??
    (<T>(write: () => Promise<T>) => {
      const pending = previousWrite.then(write);
      previousWrite = pending.then(
        () => {},
        () => {}
      );
      return pending;
    });
  const combined = new WeakMap<
    AbortSignal,
    { configuration: AbortSignal; signal: AbortSignal }
  >();
  const withConfiguration = (profile: AbortSignal | undefined) => {
    profile?.throwIfAborted();
    if (commitComfyConfiguration && profile) return profile;
    const current = configuration.capture();
    if (!profile) return current;
    const cached = combined.get(profile);
    if (cached?.configuration === current) return cached.signal;
    const signal = AbortSignal.any([current, profile]);
    combined.set(profile, { configuration: current, signal });
    return signal;
  };
  const capture = (event: IpcMainInvokeEvent) => {
    requireTrustedSender(event);
    const profile = captureInferenceProfile?.(event.sender);
    return { profile, signal: withConfiguration(profile) };
  };
  const assertAvailable = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    try {
      await assertInferenceAvailable();
    } finally {
      signal?.throwIfAborted();
    }
  };
  const readEndpoint = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const endpoint = await settings.getComfyEndpoint();
    signal?.throwIfAborted();
    return normalizeComfyEndpoint(endpoint);
  };
  ipcMain.handle(IPC_CHANNELS.comfyRestartStatus, async (event) => {
    const { signal } = capture(event);
    await assertAvailable(signal);
    const endpoint = await readEndpoint(signal);
    signal?.throwIfAborted();
    const status = await readComfyRestartStatus({ launcher, endpoint, signal });
    signal?.throwIfAborted();
    return status;
  });
  ipcMain.handle(IPC_CHANNELS.comfyRestart, async (event) => {
    const { signal } = capture(event);
    await assertAvailable(signal);
    const endpoint = await readEndpoint(signal);
    signal?.throwIfAborted();
    await restartComfy({ launcher, endpoint, signal });
    signal?.throwIfAborted();
  });
  ipcMain.handle(IPC_CHANNELS.comfyLaunch, async (event, options) => {
    const { signal } = capture(event);
    await assertAvailable(signal);
    const endpoint = await readEndpoint(signal);
    signal?.throwIfAborted();
    const restartUnresponsiveProcess =
      options &&
      typeof options === "object" &&
      "restartUnresponsiveProcess" in options &&
      options.restartUnresponsiveProcess === true;
    await launcher.launch({ restartUnresponsiveProcess, endpoint, signal });
    signal?.throwIfAborted();
  });
  ipcMain.handle(
    IPC_CHANNELS.comfyScriptSetupStatus,
    async (event, options) => {
      const { signal } = capture(event);
      await assertAvailable(signal);
      const probeSettings = await readComfySettings(settings, signal);
      signal?.throwIfAborted();
      if (options?.scriptTextModel !== undefined) {
        if (!LOCAL_SCRIPT_TEXT_MODELS.includes(options.scriptTextModel))
          throw new Error("Unknown local script text model");
        probeSettings.scriptTextModel = options.scriptTextModel;
      }
      if (options?.vlmBackend !== undefined) {
        if (!LOCAL_VLM_BACKENDS.includes(options.vlmBackend))
          throw new Error("Unknown local vision language model");
        probeSettings.vlmBackend = options.vlmBackend;
      }
      if (options?.debugMissing === true) {
        return addSetupDestinations(
          evaluateScriptSetup({}, probeSettings),
          null,
          null
        );
      }
      const endpoint = normalizeComfyEndpoint(
        options?.endpoint ?? probeSettings.endpoint
      );
      const result = await probeScriptSetup(endpoint, probeSettings, signal);
      signal?.throwIfAborted();
      if (
        !options?.endpoint &&
        result.comfyRoot &&
        path.isAbsolute(result.comfyRoot) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)
      ) {
        const directory = path.dirname(result.comfyRoot);
        await serializeWrite(async () => {
          signal?.throwIfAborted();
          await settings.setInferredComfyInstall(endpoint, directory, signal);
        });
      }
      signal?.throwIfAborted();
      return result;
    }
  );
  ipcMain.handle(IPC_CHANNELS.comfyGet, async (event) => {
    requireTrustedSender(event);
    return readComfySettings(settings);
  });
  ipcMain.handle(IPC_CHANNELS.comfySave, async (event, value, options) => {
    const { profile, signal: origin } = capture(event);
    await assertAvailable(origin);
    const payload = value && typeof value === "object" ? value : null;
    const endpoint = normalizeComfyEndpoint(
      payload && "endpoint" in payload ? String(payload.endpoint) : ""
    );
    const requestedBackend =
      payload && "vlmBackend" in payload ? payload.vlmBackend : undefined;
    const requestedScriptTextModel =
      payload && "scriptTextModel" in payload
        ? payload.scriptTextModel
        : undefined;
    if (
      typeof requestedBackend !== "string" ||
      !LOCAL_VLM_BACKENDS.includes(requestedBackend as LocalVlmBackend)
    )
      throw new Error("Unknown local vision language model");
    if (
      typeof requestedScriptTextModel !== "string" ||
      !LOCAL_SCRIPT_TEXT_MODELS.includes(
        requestedScriptTextModel as LocalScriptTextModel
      )
    )
      throw new Error("Unknown local script text model");
    // Optional, so a caller saving only the ComfyUI fields keeps the choice.
    const requestedTextModelProvider =
      payload && "textModelProvider" in payload
        ? payload.textModelProvider
        : undefined;
    if (
      requestedTextModelProvider !== undefined &&
      !LOCAL_TEXT_MODEL_PROVIDERS.includes(
        requestedTextModelProvider as LocalTextModelProvider
      )
    )
      throw new Error("Unknown text model provider");
    const write = async () => {
      const configuration = {
        endpoint,
        vlmBackend: requestedBackend as LocalVlmBackend,
        scriptTextModel: requestedScriptTextModel as LocalScriptTextModel,
        textModelProvider: requestedTextModelProvider as
          | LocalTextModelProvider
          | undefined
      };
      if (settings.saveComfyConfiguration) {
        await settings.saveComfyConfiguration(configuration);
        return;
      }
      // Older fixtures provide only the individual setters.
      await settings.setComfyEndpoint(endpoint);
      await settings.setVlmBackend(configuration.vlmBackend);
      await settings.setScriptTextModel(configuration.scriptTextModel);
      if (configuration.textModelProvider !== undefined)
        await settings.setTextModelProvider(configuration.textModelProvider);
    };
    const saved = await readComfySettings(settings, origin);
    origin.throwIfAborted();
    const changed =
      endpoint !== saved.endpoint ||
      requestedBackend !== saved.vlmBackend ||
      requestedScriptTextModel !== saved.scriptTextModel ||
      (requestedTextModelProvider !== undefined &&
        requestedTextModelProvider !== saved.textModelProvider);
    let signal = origin;
    if (changed) {
      signal =
        commitComfyConfiguration && profile
          ? await commitComfyConfiguration(event.sender, origin, write)
          : await serializeWrite(async () => {
              origin.throwIfAborted();
              configuration.suspend();
              try {
                await write();
              } finally {
                configuration.resume();
              }
              return withConfiguration(profile);
            });
      await assertAvailable(signal);
    }
    const launchPath = await launcher.getLaunchPath(endpoint, signal);
    const status = await check(
      changed ? await readComfySettings(settings, signal) : saved,
      signal
    );
    signal?.throwIfAborted();
    if (options?.completeSetupOnConnection === true && status.available) {
      await serializeWrite(async () => {
        signal?.throwIfAborted();
        await settings.markLocalSetupCompleted(signal);
      });
    }
    signal?.throwIfAborted();
    return {
      ...status,
      canLaunch: launchPath !== null,
      launchPath,
      launchedProcess: launcher.getLaunchedProcess(endpoint, signal)
    };
  });
  ipcMain.handle(IPC_CHANNELS.comfyCheck, async (event, endpoint) => {
    const { signal } = capture(event);
    await assertAvailable(signal);
    if (endpoint !== undefined && typeof endpoint !== "string")
      throw new Error("Invalid ComfyUI endpoint");
    const saved = await readComfySettings(settings, signal);
    signal?.throwIfAborted();
    if (endpoint !== undefined)
      return check(
        { ...saved, endpoint: normalizeComfyEndpoint(endpoint) },
        signal
      );
    const status = await check(saved, signal);
    signal.throwIfAborted();
    let normalized: string;
    try {
      normalized = normalizeComfyEndpoint(saved.endpoint);
    } catch {
      return {
        ...status,
        canLaunch: false,
        launchPath: null,
        launchedProcess: null
      };
    }
    const launchPath = await launcher.getLaunchPath(normalized, signal);
    signal.throwIfAborted();
    return {
      ...status,
      canLaunch: launchPath !== null,
      launchPath,
      launchedProcess: launcher.getLaunchedProcess(normalized, signal)
    };
  });
  ipcMain.handle(IPC_CHANNELS.comfyModelStatus, async (event, value) => {
    const { signal } = capture(event);
    await assertAvailable(signal);
    const payload = value && typeof value === "object" ? value : null;
    const model = payload && "model" in payload ? payload.model : undefined;
    if (!isComfyRenderModelName(model))
      throw new Error("Unknown local ComfyUI model");
    const modelSettings =
      payload &&
      "settings" in payload &&
      payload.settings &&
      typeof payload.settings === "object"
        ? (payload.settings as Record<string, unknown>)
        : {};
    const endpoint = await readEndpoint(signal);
    signal?.throwIfAborted();
    const status = await probeComfyRenderModel(
      endpoint,
      model,
      modelSettings,
      signal
    );
    signal?.throwIfAborted();
    return status;
  });
  return {
    drainLaunchCleanup: (profile: AbortSignal) =>
      launcher.drainLaunchCleanup(combined.get(profile)?.signal ?? profile)
  };
};
