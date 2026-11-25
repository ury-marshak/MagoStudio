import path from "node:path";

import type { BrowserWindow } from "electron";

import type {
  ComfySettings,
  SetupRequirementDownloadResult
} from "../../shared/contracts";

import { chooseSetupRequirementFolder } from "./chooseSetupRequirementFolder";
import { downloadSetupRequirementIntoFolder } from "./downloadSetupRequirementIntoFolder";
import { installManualNodePackDependencies } from "./installManualNodePackDependencies";
import { NodePackAlreadyInstalledError } from "./NodePackAlreadyInstalledError";
import { resolveNodePackBackupsFolder } from "./resolveNodePackBackupsFolder";
import { resolveSetupRequirements } from "./resolveSetupRequirements";
import type { SetupAttempt } from "./setupAttempt";

export const downloadSetupRequirement = async (
  window: BrowserWindow,
  settings: ComfySettings,
  name: string,
  signal?: AbortSignal,
  {
    replaceExistingNodePackIn,
    attempt
  }: { replaceExistingNodePackIn?: string; attempt?: SetupAttempt } = {}
): Promise<SetupRequirementDownloadResult | null> => {
  const issue = <T>(work: () => Promise<T>) =>
    attempt ? attempt.issue(work) : work();
  const [requirement] = await resolveSetupRequirements(
    settings,
    [name],
    signal
  );
  signal?.throwIfAborted();
  const isReplacingNodePack = replaceExistingNodePackIn !== undefined;
  if (
    isReplacingNodePack &&
    (requirement.installKind !== "node" ||
      !path.isAbsolute(replaceExistingNodePackIn))
  )
    throw new Error("Only an installed node pack can be updated in place.");
  const folder =
    replaceExistingNodePackIn ??
    (await chooseSetupRequirementFolder(window, settings, requirement, signal));
  signal?.throwIfAborted();
  if (!folder) return null;
  let savedTo: string;
  try {
    savedTo = await issue(() =>
      downloadSetupRequirementIntoFolder(requirement, folder, signal, {
        replaceExistingNodePack: isReplacingNodePack
      })
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof NodePackAlreadyInstalledError)) throw error;
    return {
      outcome: "node-pack-update-needs-confirmation",
      customNodesFolder: folder,
      nodePackDirectory: error.nodePackDirectory,
      backupsFolder: resolveNodePackBackupsFolder(folder)
    };
  }
  signal?.throwIfAborted();
  if (requirement.installKind !== "node") return { outcome: "saved", savedTo };
  const nodePackDependencies = await installManualNodePackDependencies({
    nodePackDirectory: savedTo,
    endpoint: settings.endpoint,
    signal,
    attempt
  });
  signal?.throwIfAborted();
  return { outcome: "saved", savedTo, nodePackDependencies };
};
