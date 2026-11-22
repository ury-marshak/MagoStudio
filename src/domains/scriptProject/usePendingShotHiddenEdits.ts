import { useMutationState } from "@tanstack/react-query";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import {
  EDIT_PROJECT_SHOT_MUTATION_KEY,
  type EditProjectShotAction
} from "./data/useEditProjectShot";

export const usePendingShotHiddenEdits = (
  projectId: string
): Map<string, boolean> => {
  const { work } = useRendererLibraryWork();
  const pendingEditRequests = useMutationState({
    filters: { mutationKey: EDIT_PROJECT_SHOT_MUTATION_KEY, status: "pending" },
    select: (mutation) =>
      mutation.state.variables as EditProjectShotAction | undefined
  });

  return new Map(
    pendingEditRequests.flatMap((action) => {
      const request = action?.request;
      return action?.work?.signal === work.signal &&
        !work.signal.aborted &&
        request?.projectId === projectId &&
        request.isShotHidden !== undefined
        ? [[request.timelineId, request.isShotHidden] as const]
        : [];
    })
  );
};
