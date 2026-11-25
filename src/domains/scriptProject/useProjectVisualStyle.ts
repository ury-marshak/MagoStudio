import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useSaveProjectSettingsPatch } from "./useSaveProjectSettingsPatch";

type UnconfirmedVisualStyleSave = {
  projectId: string;
  attemptedVisualStyle: string;
  failure: { error: unknown } | null;
  signal: AbortSignal;
};

export const useProjectVisualStyle = (projectId: string | undefined) => {
  const { work } = useRendererLibraryWork();
  const queryClient = useQueryClient();
  const { project, saveProjectSettingsPatchAsync } =
    useSaveProjectSettingsPatch(projectId);
  const [unconfirmedVisualStyleSave, setUnconfirmedVisualStyleSave] =
    useState<UnconfirmedVisualStyleSave | null>(null);
  const latestVisualStyleSaveIdRef = useRef(0);
  const visualStyleSaveQueueRef = useRef<{
    signal: AbortSignal;
    pending: Promise<void>;
  }>(undefined);

  const savedVisualStyle = project?.settings?.visual_style ?? "";
  const currentProjectVisualStyleSave =
    !work.signal.aborted &&
    unconfirmedVisualStyleSave?.signal === work.signal &&
    unconfirmedVisualStyleSave.projectId === projectId
      ? unconfirmedVisualStyleSave
      : null;
  const visualStyleShownInField =
    currentProjectVisualStyleSave?.attemptedVisualStyle ?? savedVisualStyle;

  const commitVisualStyle = (nextVisualStyle: string): void => {
    if (!projectId || work.signal.aborted) return;
    const targetProjectId = projectId;
    latestVisualStyleSaveIdRef.current += 1;
    const visualStyleSaveId = latestVisualStyleSaveIdRef.current;
    const isLatestVisualStyleSave = () =>
      visualStyleSaveId === latestVisualStyleSaveIdRef.current;

    const readConfirmedVisualStyle = () =>
      queryClient.getQueryData<Project>(
        libraryQueryKey(queryKeys.project.byId(targetProjectId))
      )?.settings?.visual_style ?? "";

    const sendVisualStyle = async () => {
      const pendingSave = saveProjectSettingsPatchAsync({
        visual_style: nextVisualStyle
      });
      if (!pendingSave) throw new Error("Project is not loaded");
      await pendingSave;
      work.check();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectState.byProjectId(targetProjectId)
      });
    };

    setUnconfirmedVisualStyleSave({
      projectId: targetProjectId,
      attemptedVisualStyle: nextVisualStyle,
      failure: null,
      signal: work.signal
    });

    const last = visualStyleSaveQueueRef.current;
    const pending = (
      last?.signal === work.signal ? last.pending : Promise.resolve()
    ).then(async () => {
      if (work.signal.aborted) return;
      try {
        if (nextVisualStyle !== readConfirmedVisualStyle())
          await sendVisualStyle();
      } catch (err) {
        if (work.signal.aborted || !isLatestVisualStyleSave()) return;
        setUnconfirmedVisualStyleSave({
          projectId: targetProjectId,
          attemptedVisualStyle: nextVisualStyle,
          failure: { error: err },
          signal: work.signal
        });
        return;
      }
      if (!work.signal.aborted && isLatestVisualStyleSave())
        setUnconfirmedVisualStyleSave(null);
    });
    visualStyleSaveQueueRef.current = { signal: work.signal, pending };
  };

  return {
    visualStyleShownInField,
    commitVisualStyle,
    visualStyleSaveFailure: currentProjectVisualStyleSave?.failure ?? null
  };
};
