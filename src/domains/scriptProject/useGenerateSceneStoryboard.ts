import { useUploadReferenceImage } from "@domains/asset/useUploadReferenceImage";
import { SheetGroup, ShotState } from "@schemas/scriptProject";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import {
  STORYBOARD_DEFAULT_STYLE_PROMPT,
  STORYBOARD_REFERENCE_DESCRIPTION
} from "./constants";
import { useEditSheetGroup } from "./data/useEditSheetGroup";
import { usePinSheetGroupImage } from "./data/usePinSheetGroupImage";
import { useRenderShotStoryboard } from "./data/useRenderShotStoryboard";
import { renderStoryboardInputImage } from "./renderStoryboardInputImage";
import { useReportScriptProjectFailure } from "./useReportScriptProjectFailure";
import { buildStoryboardPrompt } from "./utils/buildStoryboardPrompt";
import { buildStoryboardSheetToken } from "./utils/buildStoryboardSheetToken";
import { findClosestScriptProjectAspectRatio } from "./utils/findClosestScriptProjectAspectRatio";
import { layoutStoryboardGrid } from "./utils/layoutStoryboardGrid";
import { listSceneReferenceImages } from "./utils/listSceneReferenceImages";
import { Beat } from "./utils/shotCutListTypes";
import { withTimelineId } from "./utils/withTimelineId";

export type SceneStoryboardRequest = {
  shot: Pick<ShotState, "timeline_id" | "tags">;
  storyboardBeats: Beat[];
};

export const useGenerateSceneStoryboard = ({
  projectId,
  sheetsTimelineId,
  projectOutputSize,
  sheetGroups,
  storyboardSheetGroups,
  onStoryboardRenderAccepted
}: {
  projectId: string;
  sheetsTimelineId: string | null;
  projectOutputSize: [number, number];
  sheetGroups: SheetGroup[];
  storyboardSheetGroups: SheetGroup[];
  onStoryboardRenderAccepted: (sceneTimelineId: string) => void;
}) => {
  const { t } = useTranslation();
  const { work: origin } = useRendererLibraryWork();
  const reportScriptProjectFailure = useReportScriptProjectFailure();
  const { mutateAsync: renderShotStoryboard } =
    useRenderShotStoryboard(projectId);
  const { mutateAsync: editSheetGroup } = useEditSheetGroup(projectId);
  const { mutateAsync: pinSheetGroupImage } = usePinSheetGroupImage(projectId);
  const { mutateAsync: uploadReferenceImage } = useUploadReferenceImage();
  const [submitting, setSubmitting] = useState<{
    signal: AbortSignal;
    ids: ReadonlySet<string>;
  }>();
  const submissionKey = (timelineId: string) => `${projectId}:${timelineId}`;
  const markStoryboardSubmitting = (
    timelineId: string,
    isSubmitting: boolean,
    work: RendererLibraryWork
  ) =>
    setSubmitting((previous) => {
      if (work.signal.aborted) return previous;
      return {
        signal: work.signal,
        ids: withTimelineId(
          submissionKey(timelineId),
          isSubmitting
        )(previous?.signal === work.signal ? previous.ids : new Set())
      };
    });

  const panelAspectRatio =
    findClosestScriptProjectAspectRatio(projectOutputSize);

  const uploadStoryboardGrid = async (
    { shot, storyboardBeats }: SceneStoryboardRequest,
    work: RendererLibraryWork
  ): Promise<string> => {
    work.check();
    const { panelBoxes } = layoutStoryboardGrid({
      panelCount: storyboardBeats.length,
      panelAspectRatio:
        panelAspectRatio.widthUnits / panelAspectRatio.heightUnits
    });
    const storyboardGridFile = await renderStoryboardInputImage({
      panelBoxes,
      fileName: `storyboard-grid-${shot.timeline_id}.png`
    });
    work.check();
    const storyboardGridAssetId = await uploadReferenceImage({
      file: storyboardGridFile,
      projectId,
      work
    });
    if (!storyboardGridAssetId)
      throw new Error("Uploading the storyboard grid returned no asset");
    return storyboardGridAssetId;
  };

  const showLatestStoryboardWithReferenceDescription = async (
    storyboardSheetsTimelineId: string,
    storyboardSheetToken: string,
    work: RendererLibraryWork
  ): Promise<void> => {
    if (work.signal.aborted) return;
    try {
      await pinSheetGroupImage(
        {
          timelineId: storyboardSheetsTimelineId,
          token: storyboardSheetToken,
          selectedAssetId: null
        },
        work
      );
      work.check();
      await editSheetGroup(
        {
          timelineId: storyboardSheetsTimelineId,
          token: storyboardSheetToken,
          description: STORYBOARD_REFERENCE_DESCRIPTION
        },
        work
      );
    } catch (error) {
      if (work.signal.aborted) return;
      reportScriptProjectFailure(
        error,
        t("script_project.storyboard_sheet_setup_failed.description"),
        () =>
          void showLatestStoryboardWithReferenceDescription(
            storyboardSheetsTimelineId,
            storyboardSheetToken,
            work
          )
      );
    }
  };

  const generateSceneStoryboard = async (
    request: SceneStoryboardRequest,
    work = origin
  ): Promise<void> => {
    const { shot, storyboardBeats } = request;
    if (work.signal.aborted || !sheetsTimelineId || !storyboardBeats.length)
      return;
    const timelineId = shot.timeline_id;
    markStoryboardSubmitting(timelineId, true, work);
    const storyboardSheetToken = buildStoryboardSheetToken(timelineId);

    try {
      const isStoryboardRemovedFromScene = storyboardSheetGroups.some(
        (sheetGroup) =>
          sheetGroup.token === storyboardSheetToken && !sheetGroup.enabled
      );
      if (isStoryboardRemovedFromScene)
        await editSheetGroup(
          {
            timelineId: sheetsTimelineId,
            token: storyboardSheetToken,
            enabled: true
          },
          work
        );
      const storyboardGridAssetId = await uploadStoryboardGrid(request, work);
      work.check();

      const characterReferenceImages = listSceneReferenceImages({
        tags: shot.tags,
        sheetGroups,
        tagCategories: ["characters"]
      });
      await renderShotStoryboard(
        {
          sheetsTimelineId,
          shotTimelineId: timelineId,
          prompt: buildStoryboardPrompt({
            cutList: {
              sceneDescription: "",
              midExchangeOpening: "",
              beats: storyboardBeats
            },
            hasUserSketch: false,
            panelAspectRatio,
            stylePrompt: STORYBOARD_DEFAULT_STYLE_PROMPT,
            characterNames: characterReferenceImages.map(
              (characterReferenceImage) => characterReferenceImage.name
            )
          }),
          inputImageAssetIds: [
            storyboardGridAssetId,
            ...characterReferenceImages.map(
              (characterReferenceImage) => characterReferenceImage.assetId
            )
          ]
        },
        work
      );
      work.check();
    } catch (error) {
      if (!work.signal.aborted)
        reportScriptProjectFailure(
          error,
          t("script_project.generate_storyboard_failed.description"),
          () => void generateSceneStoryboard(request, work)
        );
      return;
    } finally {
      if (!work.signal.aborted)
        markStoryboardSubmitting(timelineId, false, work);
    }

    onStoryboardRenderAccepted(timelineId);
    await showLatestStoryboardWithReferenceDescription(
      sheetsTimelineId,
      storyboardSheetToken,
      work
    );
  };

  return {
    generateSceneStoryboard: (request: SceneStoryboardRequest, work = origin) =>
      void generateSceneStoryboard(request, work),
    canGenerateSceneStoryboards: sheetsTimelineId !== null,
    isSubmittingSceneStoryboard: (timelineId: string) =>
      !origin.signal.aborted &&
      submitting?.signal === origin.signal &&
      submitting.ids.has(submissionKey(timelineId))
  };
};
