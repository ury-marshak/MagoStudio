import { deleteTimeline } from "@domains/shot/deleteTimeline";
import { useQueryClient } from "@tanstack/react-query";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useProjectShotFolders } from "./shotFolders/useProjectShotFolders";
import { useUpdateProjectShotFolders } from "./shotFolders/useUpdateProjectShotFolders";
import { useDeleteProject } from "./useDeleteProject";
import { getAllDescendantIds } from "./utils/getAllDescendantIds";
import { shouldDeleteProjectAfter } from "./utils/shouldDeleteProjectAfter";

export interface DeleteShotItemResult {
  allShotDeletesSucceeded: boolean;
  willEmptyProject: boolean;
}

export interface DeleteShotItemOptions {
  skipProjectDelete?: boolean;
}

export const useDeleteShotItem = (projectId: string | undefined) => {
  const { data } = useProjectShotFolders(projectId);
  const { mutateAsync: updateShotFolders, isPending } =
    useUpdateProjectShotFolders(projectId);
  const { mutateAsync: deleteProject } = useDeleteProject();
  const queryClient = useQueryClient();

  const deleteItem = async (
    itemId: string,
    options?: DeleteShotItemOptions
  ): Promise<DeleteShotItemResult> => {
    const work = rendererLibrary.capture();
    work.check();
    const allItems = data?.shotFoldersAndShots ?? [];
    const item = allItems.find((i) => i.id === itemId);
    if (!item) {
      return { allShotDeletesSucceeded: true, willEmptyProject: false };
    }

    const idsToRemove = new Set([itemId]);

    if (item.type === "folder") {
      for (const descendantId of getAllDescendantIds(itemId, allItems)) {
        idsToRemove.add(descendantId);
      }
    }

    const willEmptyProject = shouldDeleteProjectAfter(idsToRemove, allItems);

    const shotIdsToDelete = allItems
      .filter((i) => idsToRemove.has(i.id) && i.type === "shot")
      .map((i) => i.id);

    const updated = allItems.filter((i) => !idsToRemove.has(i.id));

    try {
      await updateShotFolders(updated, work);
    } catch {
      work.check();
      return { allShotDeletesSucceeded: false, willEmptyProject };
    }

    const results = await Promise.allSettled(
      shotIdsToDelete.map((id) => deleteTimeline(id, projectId, work))
    );
    work.check();
    const allShotDeletesSucceeded = results.every(
      (r) => r.status === "fulfilled"
    );

    if (
      willEmptyProject &&
      allShotDeletesSucceeded &&
      projectId &&
      !options?.skipProjectDelete
    ) {
      try {
        await deleteProject({ projectId }, work);
      } catch {}
    }

    work.check();
    await queryClient.invalidateQueries({
      queryKey: queryKeys.project.byId(projectId)
    });
    work.check();

    return { allShotDeletesSucceeded, willEmptyProject };
  };

  return {
    mutateAsync: deleteItem,
    isPending
  };
};
