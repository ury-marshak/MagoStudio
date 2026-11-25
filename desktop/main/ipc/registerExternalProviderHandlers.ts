import { ipcMain, type WebContents } from "electron";

import {
  IPC_CHANNELS,
  type ExternalModelCapability
} from "../../shared/contracts";
import {
  type createExternalProviderSettings,
  readExternalProviderKey
} from "../providers/externalProviderSettings";
import { probeOpenAiCompatible } from "../providers/openAiCompatible";
import { waitForInference } from "../providers/sharedInference";

import { requireTrustedSender } from "./trustedSender";

const capabilityFrom = (value: unknown): ExternalModelCapability => {
  if (value === "text" || value === "vision") return value;
  throw new Error("Unknown external provider capability");
};

export const registerExternalProviderHandlers = (
  settings: ReturnType<typeof createExternalProviderSettings>,
  {
    captureAccountProfile
  }: { captureAccountProfile?: (sender: WebContents) => AbortSignal } = {}
): void => {
  ipcMain.handle(IPC_CHANNELS.externalProvidersGet, (event, capability) => {
    requireTrustedSender(event);
    return capability === "fal"
      ? settings.getFal()
      : settings.get(capabilityFrom(capability));
  });
  ipcMain.handle(
    IPC_CHANNELS.externalProvidersSave,
    async (event, capability, config) => {
      requireTrustedSender(event);
      const origin = captureAccountProfile?.(event.sender);
      const result = await (capability === "fal"
        ? settings.saveFal(config, origin)
        : settings.save(capabilityFrom(capability), config, origin));
      origin?.throwIfAborted();
      return result;
    }
  );
  ipcMain.handle(IPC_CHANNELS.externalProvidersCheck, async (event, value) => {
    requireTrustedSender(event);
    const account = captureAccountProfile?.(event.sender);
    const capability = value === "fal" ? null : capabilityFrom(value);
    const profile = settings.captureInferenceProfile();
    const signal = account ? AbortSignal.any([account, profile]) : profile;
    signal.throwIfAborted();
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      if (!capability) {
        const config = await settings.getFal();
        signal.throwIfAborted();
        if (!config)
          throw new Error("Save the fal Keychain account before checking it");
        await readExternalProviderKey(config.keychainAccount, signal);
        return;
      }
      const config = await settings.get(capability);
      signal.throwIfAborted();
      if (!config)
        throw new Error("Save an external provider before checking it");
      const key = await readExternalProviderKey(config.keychainAccount, signal);
      signal.throwIfAborted();
      await probeOpenAiCompatible(config, key, capability, signal);
    });
    await waitForInference(task, signal);
    signal.throwIfAborted();
  });
};
