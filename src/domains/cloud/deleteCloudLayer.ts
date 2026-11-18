import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

export const deleteCloudLayer = async (
  cloudLayerId: string,
  work = rendererLibrary.capture()
): Promise<void> => {
  await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.delete(`/layers/${cloudLayerId}`, { signal })
  );
};
