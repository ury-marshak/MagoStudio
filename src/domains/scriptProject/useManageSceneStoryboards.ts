import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { UpdateSceneStoryboardRequest } from "./api/putSceneStoryboard";
import { useSubmitSceneStoryboard } from "./data/useSubmitSceneStoryboard";
import { useUpdateSceneStoryboard } from "./data/useUpdateSceneStoryboard";
import { useReportScriptProjectFailure } from "./useReportScriptProjectFailure";
import { withTimelineId } from "./utils/withTimelineId";

export const useManageSceneStoryboards = (
  projectId: string,
  renderModel?: string
) => {
  const { t } = useTranslation();
  const { work: origin } = useRendererLibraryWork();
  const reportScriptProjectFailure = useReportScriptProjectFailure();
  const { mutateAsync: submitSceneStoryboard } = useSubmitSceneStoryboard();
  const { mutateAsync: updateSceneStoryboard } = useUpdateSceneStoryboard();
  const [busy, setBusy] = useState<{
    signal: AbortSignal;
    keys: ReadonlySet<string>;
  }>();
  const markBusy = (key: string, isBusy: boolean, work: RendererLibraryWork) =>
    setBusy((previous) => {
      if (work.signal.aborted) return previous;
      return {
        signal: work.signal,
        keys: withTimelineId(
          key,
          isBusy
        )(previous?.signal === work.signal ? previous.keys : new Set())
      };
    });
  const submitKey = (timelineId: string) => `${projectId}:submit:${timelineId}`;
  const updateKey = (timelineId: string) => `${projectId}:update:${timelineId}`;
  const isBusy = (key: string) =>
    !origin.signal.aborted &&
    busy?.signal === origin.signal &&
    busy.keys.has(key);

  const generateSceneStoryboard = async (
    sceneTimelineId: string,
    model = renderModel,
    providerSettings?: Record<string, string | number | null>,
    work = origin
  ): Promise<void> => {
    if (work.signal.aborted) return;
    const key = submitKey(sceneTimelineId);
    markBusy(key, true, work);
    try {
      await submitSceneStoryboard(
        {
          projectId,
          sceneTimelineId,
          ...(model ? { renderModel: model } : {}),
          ...(providerSettings ? { providerSettings } : {})
        },
        work
      );
    } catch (error) {
      if (!work.signal.aborted)
        reportScriptProjectFailure(
          error,
          t("script_project.generate_storyboard_failed.description"),
          () =>
            void generateSceneStoryboard(
              sceneTimelineId,
              model,
              providerSettings,
              work
            )
        );
    } finally {
      if (!work.signal.aborted) markBusy(key, false, work);
    }
  };

  const updateOneSceneStoryboard = async (
    request: Omit<UpdateSceneStoryboardRequest, "projectId">,
    work: RendererLibraryWork
  ): Promise<void> => {
    if (work.signal.aborted) return;
    const key = updateKey(request.sceneTimelineId);
    markBusy(key, true, work);
    try {
      await updateSceneStoryboard({ projectId, ...request }, work);
    } catch (error) {
      if (!work.signal.aborted)
        reportScriptProjectFailure(
          error,
          t("script_project.update_storyboard_failed.description")
        );
    } finally {
      if (!work.signal.aborted) markBusy(key, false, work);
    }
  };

  return {
    generateSceneStoryboard,
    isSubmittingSceneStoryboard: (sceneTimelineId: string) =>
      isBusy(submitKey(sceneTimelineId)),
    pinSceneStoryboardVersion: (
      sceneTimelineId: string,
      selectedAssetId: string | null,
      work = origin
    ) =>
      void updateOneSceneStoryboard({ sceneTimelineId, selectedAssetId }, work),
    setSceneStoryboardUsedInVideoRenders: (
      sceneTimelineId: string,
      isUsedInVideoRenders: boolean,
      work = origin
    ) =>
      void updateOneSceneStoryboard(
        { sceneTimelineId, isUsedInVideoRenders },
        work
      ),
    isUpdatingSceneStoryboard: (sceneTimelineId: string) =>
      isBusy(updateKey(sceneTimelineId))
  };
};
