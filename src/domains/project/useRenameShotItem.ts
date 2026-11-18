import { putTimeline } from "@domains/shot/putTimeline";
import { useQueryClient } from "@tanstack/react-query";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useProjectShotFolders } from "./shotFolders/useProjectShotFolders";
import { useUpdateProjectShotFolders } from "./shotFolders/useUpdateProjectShotFolders";

export const useRenameShotItem = (projectId: string | undefined) => {
  const { data } = useProjectShotFolders(projectId);
  const { mutateAsync: updateShotFolders } =
    useUpdateProjectShotFolders(projectId);
  const queryClient = useQueryClient();

  const renameItem = async (itemId: string, newName: string) => {
    const work = rendererLibrary.capture();
    work.check();
    const items = data?.shotFoldersAndShots ?? [];
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const updated = items.map((i) =>
      i.id === itemId ? { ...i, name: newName } : i
    );
    await updateShotFolders(updated, work);
    work.check();

    if (item.type === "shot" && projectId) {
      const shot = data?.project?.timelines?.find((s) => s.id === itemId);
      await putTimeline(
        itemId,
        {
          name: newName,
          settings: shot?.settings ?? {},
          project_id: projectId
        },
        work
      );
      work.check();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.project.byId(projectId)
      });
      work.check();
    }
  };

  return { renameItem };
};
