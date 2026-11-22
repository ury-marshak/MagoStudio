import { backendCloudApi } from "@domains/cloud/backendCloudApi";
import { ensureCloudImageAsset } from "@domains/cloud/mirrorService";
import {
  BulkRendersRun,
  BulkRendersRunSchema,
  CreateBulkRendersRunRequest,
  CreateBulkRendersRunRequestSchema
} from "@schemas/bulkRendersRun";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { collectBulkRendersRunRequestImageAssetIds } from "../utils/collectBulkRendersRunRequestImageAssetIds";
import { replaceBulkRendersRunRequestImageAssetIds } from "../utils/replaceBulkRendersRunRequestImageAssetIds";

export const postBulkRendersRun = async (
  request: CreateBulkRendersRunRequest,
  work: RendererLibraryWork
): Promise<BulkRendersRun> => {
  work.check();
  const validatedRequest = CreateBulkRendersRunRequestSchema.parse(request);
  const cloudApi = backendCloudApi();
  const cloudAssetIdByLocalAssetId = new Map<string, string>();
  for (const localAssetId of collectBulkRendersRunRequestImageAssetIds(
    validatedRequest
  )) {
    work.check();
    cloudAssetIdByLocalAssetId.set(
      localAssetId,
      await ensureCloudImageAsset(
        cloudApi,
        localAssetId,
        validatedRequest.project_id,
        undefined,
        work
      )
    );
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(
      "/agent/plans",
      replaceBulkRendersRunRequestImageAssetIds(
        validatedRequest,
        cloudAssetIdByLocalAssetId
      ),
      { signal }
    )
  );
  work.check();
  return BulkRendersRunSchema.parse(response.data);
};
