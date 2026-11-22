import { SheetGroup, ShotState } from "@schemas/scriptProject";
import { useEffect, useMemo } from "react";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { useEditProjectShot } from "./useEditProjectShot";
import { buildStoryboardSheetToken } from "./utils/buildStoryboardSheetToken";
import {
  STORYBOARD_TAG_CATEGORY,
  planStoryboardSceneTagChanges
} from "./utils/planStoryboardSceneTagChanges";
import {
  withShotTagAdded,
  withShotTagRemoved
} from "./utils/shotTagCategories";

export const useKeepStoryboardTagsNonBlocking = ({
  projectId,
  scenes,
  storyboardSheetGroups
}: {
  projectId: string;
  scenes: ShotState[];
  storyboardSheetGroups: SheetGroup[];
}) => {
  const { mutate: editShot } = useEditProjectShot();
  const { work } = useRendererLibraryWork();
  const {
    sceneTimelineIdsAwaitingStoryboard,
    sceneTimelineIdsWithTagEditInFlight
  } = useMemo(
    () => ({
      sceneTimelineIdsAwaitingStoryboard: new Set<string>(),
      sceneTimelineIdsWithTagEditInFlight: new Set<string>()
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- never share pending tag bookkeeping across projects or libraries
    [projectId, work]
  );

  const editStoryboardTag = (
    scene: ShotState,
    withStoryboardTagChanged: typeof withShotTagAdded
  ) => {
    const sceneTimelineId = scene.timeline_id;
    if (work.signal.aborted) return;
    if (sceneTimelineIdsWithTagEditInFlight.has(sceneTimelineId)) return;
    sceneTimelineIdsWithTagEditInFlight.add(sceneTimelineId);
    editShot(
      {
        projectId,
        timelineId: sceneTimelineId,
        tags: withStoryboardTagChanged(
          scene.tags,
          STORYBOARD_TAG_CATEGORY,
          buildStoryboardSheetToken(sceneTimelineId)
        )
      },
      work,
      undefined,
      () => sceneTimelineIdsWithTagEditInFlight.delete(sceneTimelineId)
    );
  };

  // oxlint-disable-next-line custom-react/no-use-effect -- external sync: tags a storyboard onto its scene only once it has an image, and untags one without, because the backend blocks a scene's video on any tag with no image
  useEffect(() => {
    if (work.signal.aborted) return;
    const changes = planStoryboardSceneTagChanges({
      scenes,
      storyboardSheetGroups,
      sceneTimelineIdsAwaitingStoryboard
    });
    changes.scenesToDetachStoryboard.forEach((scene) =>
      editStoryboardTag(scene, withShotTagRemoved)
    );
    changes.scenesToAttachStoryboard.forEach((scene) =>
      editStoryboardTag(scene, withShotTagAdded)
    );
    changes.sceneTimelineIdsNowAwaitingStoryboard.forEach((sceneTimelineId) =>
      sceneTimelineIdsAwaitingStoryboard.add(sceneTimelineId)
    );
    changes.sceneTimelineIdsNoLongerAwaitingStoryboard.forEach(
      (sceneTimelineId) =>
        sceneTimelineIdsAwaitingStoryboard.delete(sceneTimelineId)
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- editStoryboardTag is read fresh each run; the plan only changes with the scenes and their storyboards, which refresh after every storyboard render
  }, [scenes, storyboardSheetGroups, projectId]);

  return {
    markSceneAwaitingStoryboard: (sceneTimelineId: string) => {
      if (!work.signal.aborted)
        sceneTimelineIdsAwaitingStoryboard.add(sceneTimelineId);
    }
  };
};
