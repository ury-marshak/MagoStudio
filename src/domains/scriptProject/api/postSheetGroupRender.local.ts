import { backendCloudApi } from "@domains/cloud/backendCloudApi";
import { ensureCloudImageAsset } from "@domains/cloud/mirrorService";
import { RenderMode } from "@hooks/types";
import {
  SheetGenerateResult,
  SheetGenerateResultSchema,
  SheetKind
} from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import {
  canUseCloudSheetModels,
  executeCloudSheetPlan
} from "../cloudSheetRender.local";
import { SHEET_IMAGE_EDIT_MODEL_BY_RENDER_MODEL } from "../cloudSheetRender.local";
import {
  AnySheetRenderModel,
  DEFAULT_SHEET_IMAGE_FILE_TYPE,
  isFalSheetModel,
  resolveLocalSheetRenderModel
} from "../constants";
import { isLocalScriptProject } from "../projectOrigin";
import { buildSheetReferencePrompt } from "../utils/buildSheetReferencePrompt";
import { isSheetRenderModel } from "../utils/isSheetRenderModel";

import { generateLocalSheets } from "./generateLocalSheets";
import { patchSheetGroup } from "./patchSheetGroup";

export type RenderSheetGroupRequest = {
  projectId?: string;
  timelineId: string;
  token: string;
  name?: string;
  kind?: SheetKind | null;
  masterToken?: string | null;
  prompt: string;
  renderModel: AnySheetRenderModel;
  providerSettings?: Record<string, string | number | null>;
  renderMode: RenderMode;
  outputSize: [number, number];
  referenceAssetIds?: string[];
  referenceInstruction?: string;
};

export const postSheetGroupRender = async (
  request: RenderSheetGroupRequest,
  work = rendererLibrary.capture()
): Promise<SheetGenerateResult | null> => {
  const { projectId } = request;
  if (
    projectId &&
    (await work.boundary(() => isLocalScriptProject(projectId)))
  ) {
    const isCloudModel =
      isSheetRenderModel(request.renderModel) && canUseCloudSheetModels();
    const result = SheetGenerateResultSchema.parse(
      await generateLocalSheets(
        {
          projectId,
          isDryRun: false,
          outputSize: request.outputSize,
          settings: {
            prompt: request.prompt,
            ...(request.providerSettings
              ? { provider_settings: request.providerSettings }
              : {}),
            render_model:
              isCloudModel || isFalSheetModel(request.renderModel)
                ? request.renderModel
                : resolveLocalSheetRenderModel(request.renderModel)
          },
          tokens: [request.token],
          ...(request.name === undefined && request.kind === undefined
            ? {}
            : {
                sheetGroupToCreate: {
                  name: request.name,
                  kind: request.kind
                }
              }),
          ...(request.referenceAssetIds === undefined
            ? {}
            : {
                referenceAssetIds: request.referenceAssetIds,
                referenceInstruction: request.referenceInstruction
              })
        },
        work
      )
    );
    work.check();
    if (isCloudModel && result.plan_id)
      void executeCloudSheetPlan(result.plan_id, work);
    return result;
  }
  if (projectId && request.masterToken) {
    const cloudReferenceAssetIds = request.referenceAssetIds?.length
      ? await Promise.all(
          request.referenceAssetIds.map((assetId) =>
            ensureCloudImageAsset(
              backendCloudApi(),
              assetId,
              projectId,
              undefined,
              work
            )
          )
        )
      : undefined;
    const response = await runRendererLibraryRequest(work, (signal) =>
      backendApiClient.post(
        `/projects/${projectId}/sheets/generate`,
        {
          output_size: request.outputSize,
          settings: {
            render_model: request.renderModel,
            render_mode: request.renderMode
          },
          tokens: [request.token],
          ...(cloudReferenceAssetIds !== undefined
            ? {
                reference_asset_ids: cloudReferenceAssetIds,
                reference_instruction: request.referenceInstruction
              }
            : {}),
          dry_run: false
        },
        { signal }
      )
    );
    return SheetGenerateResultSchema.parse(response.data);
  }
  const cloudReferenceIds =
    request.referenceAssetIds && projectId
      ? await Promise.all(
          request.referenceAssetIds.map((assetId) =>
            ensureCloudImageAsset(
              backendCloudApi(),
              assetId,
              projectId,
              undefined,
              work
            )
          )
        )
      : request.referenceAssetIds;
  if (cloudReferenceIds !== undefined)
    await patchSheetGroup(
      {
        timelineId: request.timelineId,
        token: request.token,
        referenceAssetIds: cloudReferenceIds,
        referenceInstruction: cloudReferenceIds.length
          ? (request.referenceInstruction?.trim() ?? "")
          : null
      },
      work
    );
  const [inputImageId, ...additionalReferences] = cloudReferenceIds ?? [];
  const [width, height] = request.outputSize;
  await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(
      `/assets/img2img/render`,
      {
        timeline_id: request.timelineId,
        sheet_token: request.token,
        ...(request.name ? { sheet_name: request.name } : {}),
        ...(request.kind ? { sheet_kind: request.kind } : {}),
        img_file_type: DEFAULT_SHEET_IMAGE_FILE_TYPE,
        render_model:
          inputImageId && isSheetRenderModel(request.renderModel)
            ? SHEET_IMAGE_EDIT_MODEL_BY_RENDER_MODEL[request.renderModel]
            : request.renderModel,
        render_mode: request.renderMode,
        ...(inputImageId ? { source_asset: inputImageId, frame: 0 } : {}),
        settings: {
          prompt: inputImageId
            ? buildSheetReferencePrompt({
                prompt: request.prompt,
                referenceInstruction: request.referenceInstruction
              })
            : request.prompt,
          width,
          height,
          ...(inputImageId
            ? {
                input_image_id: inputImageId,
                reference_images: additionalReferences
              }
            : {})
        }
      },
      { signal }
    )
  );
  return null;
};
