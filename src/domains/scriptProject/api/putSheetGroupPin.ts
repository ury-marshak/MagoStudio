import { SheetGroup, SheetGroupSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

export type PinSheetGroupImageRequest = {
  projectId?: string;
  timelineId: string;
  token: string;
  selectedAssetId: string | null;
};

export const putSheetGroupPin = async (
  { timelineId, token, selectedAssetId }: PinSheetGroupImageRequest,
  work = rendererLibrary.capture()
): Promise<SheetGroup> => {
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.put(
      `/timelines/${timelineId}/sheets/${encodeURIComponent(token)}`,
      { selected_asset_id: selectedAssetId },
      { signal }
    )
  );
  return SheetGroupSchema.parse(response.data);
};
