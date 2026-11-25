import { stat } from "node:fs/promises";
import path from "node:path";

import type { BrowserWindow } from "electron";

import type { ComfySettings } from "../../shared/contracts";

import { chooseSetupRequirementFolder } from "./chooseSetupRequirementFolder";
import { downloadSetupRequirementIntoFolder } from "./downloadSetupRequirementIntoFolder";
import { resolveSetupRequirements } from "./resolveSetupRequirements";
import type { SetupAttempt } from "./setupAttempt";

const isFinishedFileInFolder = async (folder: string, name: string) =>
  (await stat(path.join(folder, name)).catch(() => null))?.isFile() ?? false;

export const downloadSetupRequirements = async (
  window: BrowserWindow,
  settings: ComfySettings,
  names: string[],
  signal?: AbortSignal,
  attempt?: SetupAttempt
): Promise<string | null> => {
  const requirements = await resolveSetupRequirements(settings, names, signal);
  signal?.throwIfAborted();
  const [firstRequirement] = requirements;
  if (!firstRequirement) return null;
  const chosenFolder = await chooseSetupRequirementFolder(
    window,
    settings,
    firstRequirement,
    signal
  );
  signal?.throwIfAborted();
  if (!chosenFolder) return null;
  for (const requirement of requirements) {
    signal?.throwIfAborted();
    if (await isFinishedFileInFolder(chosenFolder, requirement.name)) continue;
    try {
      signal?.throwIfAborted();
      const download = () =>
        downloadSetupRequirementIntoFolder(requirement, chosenFolder, signal);
      await (attempt ? attempt.issue(download) : download());
    } catch (error) {
      signal?.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${requirement.name}: ${reason}`);
    }
  }
  signal?.throwIfAborted();
  return chosenFolder;
};
