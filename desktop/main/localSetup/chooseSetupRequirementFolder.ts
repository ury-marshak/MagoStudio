import { stat } from "node:fs/promises";
import path from "node:path";

import { BrowserWindow, dialog } from "electron";

import type {
  ComfySettings,
  ScriptSetupRequirement
} from "../../shared/contracts";

export const chooseSetupRequirementFolder = async (
  window: BrowserWindow,
  settings: ComfySettings,
  requirement: ScriptSetupRequirement,
  signal?: AbortSignal
): Promise<string | null> => {
  signal?.throwIfAborted();
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(settings.endpoint).hostname
  );
  let defaultPath =
    isLocal && requirement.folder && path.isAbsolute(requirement.folder)
      ? requirement.folder
      : undefined;
  while (
    defaultPath &&
    !(await stat(defaultPath).catch(() => null))?.isDirectory()
  ) {
    signal?.throwIfAborted();
    const parent = path.dirname(defaultPath);
    defaultPath = parent === defaultPath ? undefined : parent;
  }
  signal?.throwIfAborted();
  const choice = await dialog.showOpenDialog(window, {
    title:
      requirement.installKind === "node"
        ? "Choose where to download the node ZIP"
        : "Choose the model download folder",
    defaultPath,
    properties: ["openDirectory", "createDirectory"]
  });
  signal?.throwIfAborted();
  return choice.canceled ? null : (choice.filePaths[0] ?? null);
};
