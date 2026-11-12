import { ipcMain } from "electron";

import {
  IPC_CHANNELS,
  type ExternalModelCapability
} from "../../shared/contracts";
import {
  type createExternalProviderSettings,
  readExternalProviderKey
} from "../providers/externalProviderSettings";
import { probeOpenAiCompatible } from "../providers/openAiCompatible";

import { requireTrustedSender } from "./trustedSender";

const capabilityFrom = (value: unknown): ExternalModelCapability => {
  if (value === "text" || value === "vision") return value;
  throw new Error("Unknown external provider capability");
};

export const registerExternalProviderHandlers = (
  settings: ReturnType<typeof createExternalProviderSettings>
): void => {
  ipcMain.handle(IPC_CHANNELS.externalProvidersGet, (event, capability) => {
    requireTrustedSender(event);
    return capability === "fal"
      ? settings.getFal()
      : settings.get(capabilityFrom(capability));
  });
  ipcMain.handle(
    IPC_CHANNELS.externalProvidersSave,
    (event, capability, config) => {
      requireTrustedSender(event);
      return capability === "fal"
        ? settings.saveFal(config)
        : settings.save(capabilityFrom(capability), config);
    }
  );
  ipcMain.handle(IPC_CHANNELS.externalProvidersCheck, async (event, value) => {
    requireTrustedSender(event);
    if (value === "fal") {
      const config = await settings.getFal();
      if (!config)
        throw new Error("Save the fal Keychain account before checking it");
      await readExternalProviderKey(config.keychainAccount);
      return;
    }
    const capability = capabilityFrom(value);
    const config = await settings.get(capability);
    if (!config)
      throw new Error("Save an external provider before checking it");
    const key = await readExternalProviderKey(config.keychainAccount);
    await probeOpenAiCompatible(config, key, capability);
  });
};
