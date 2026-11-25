import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

export const swapInNodePack = async ({
  stagedNodePack,
  nodePackDirectory,
  replacedNodePack,
  signal
}: {
  stagedNodePack: string;
  nodePackDirectory: string;
  replacedNodePack: string;
  signal?: AbortSignal;
}): Promise<void> => {
  const hasPreviousNodePack = Boolean(
    await stat(nodePackDirectory).catch(() => null)
  );
  if (hasPreviousNodePack) {
    await mkdir(path.dirname(replacedNodePack), { recursive: true });
    signal?.throwIfAborted();
    await rename(nodePackDirectory, replacedNodePack);
  } else signal?.throwIfAborted();
  // Once the first rename is issued, complete the swap or roll it back.
  try {
    await rename(stagedNodePack, nodePackDirectory);
  } catch (error) {
    if (hasPreviousNodePack) await rename(replacedNodePack, nodePackDirectory);
    throw error;
  }
};
