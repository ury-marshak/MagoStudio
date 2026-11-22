import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import type {
  LocalScriptProjectSnapshot,
  LocalScriptProjectSnapshotInput
} from "../../../desktop/shared/contracts";

export const readScriptProjectSnapshot = async (
  _projectId: string,
  _work?: RendererLibraryWork
): Promise<LocalScriptProjectSnapshot | null> => null;

export const writeScriptProjectSnapshot = async (
  _input: LocalScriptProjectSnapshotInput,
  _work?: RendererLibraryWork
): Promise<void> => {};
