import path from "node:path";

import { copyModelsToRunningComfy } from "./copyModelsToRunningComfy";
import type { ModelGroupItem } from "./listModelGroupItems";
import type { SetupAttempt } from "./setupAttempt";

export const MANUAL_COMFY_MODEL_COPY_MESSAGE =
  "The model files are downloaded to the installation folder by default. Your current ComfyUI server folder cannot be accessed, please copy the files there manually.";
const BYTES_PER_GB = 1_000_000_000;

export const modelCopyConfirmationMessage = (bytes: number): string =>
  `The ComfyUI URL provided is not from the MagoStudio-provided ComfyUI-bundle. The model files are downloaded to the installation folder by default. Copy the model files to your currently running ComfyUI models folder? This will use ${(bytes / BYTES_PER_GB).toFixed(1)} GB of disk space.`;

export const confirmAndCopyInstallerModels = async ({
  endpoint,
  managedComfyDirectory,
  items,
  signal,
  confirmCopy,
  showCopyError,
  attempt,
  prepareCopy = copyModelsToRunningComfy
}: {
  endpoint: string;
  managedComfyDirectory: string;
  items: Extract<ModelGroupItem, { kind: "model-file" }>[];
  signal: AbortSignal;
  confirmCopy: (bytes: number) => Promise<boolean>;
  showCopyError: () => Promise<void>;
  attempt?: SetupAttempt;
  prepareCopy?: typeof copyModelsToRunningComfy;
}): Promise<void> => {
  signal.throwIfAborted();
  if (items.length === 0) return;
  const copy = await prepareCopy(endpoint, signal);
  signal.throwIfAborted();
  if (!copy) {
    await showCopyError();
    signal.throwIfAborted();
    return;
  }
  const normalize = (folder: string) =>
    process.platform === "win32"
      ? path.resolve(folder).toLowerCase()
      : path.resolve(folder);
  if (normalize(copy.comfyRoot) === normalize(managedComfyDirectory)) return;
  const uniqueItems = [
    ...new Map(items.map((item) => [item.absolutePath, item])).values()
  ];
  const approved = await confirmCopy(
    uniqueItems.reduce((bytes, item) => bytes + item.bytes, 0)
  );
  signal.throwIfAborted();
  if (!approved) return;
  try {
    for (const item of uniqueItems) {
      signal.throwIfAborted();
      if (attempt) await attempt.issue(() => copy(item, signal));
      else await copy(item, signal);
    }
  } catch (error) {
    signal.throwIfAborted();
    await showCopyError();
    signal.throwIfAborted();
  }
};
