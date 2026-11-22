import {
  EditedShot,
  EditedShotSchema,
  SequentialShotConfig,
  ShotCamera,
  ShotDialogueTurn,
  ShotTags
} from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

export type EditProjectShotRequest = {
  projectId: string;
  timelineId: string;
  heading?: string;
  videoPrompt?: string | null;
  dialogue?: ShotDialogueTurn[] | null;
  /** `null` clears the override, so the shot falls back to the project-wide length. */
  durationSeconds?: number | null;
  tags?: Partial<ShotTags>;
  camera?: ShotCamera | null;
  /** `null` clears the preference, so the shot stops continuing from its predecessor. */
  sequential?: SequentialShotConfig | null;
  locked?: boolean;
  isShotHidden?: boolean;
  isShotLocked?: boolean;
  /** 0-based position in the Shots tab. The backend shifts every Shot in between. */
  shotIndex?: number;
};

export const patchProjectShot = async (
  {
    projectId,
    timelineId,
    heading,
    videoPrompt,
    dialogue,
    durationSeconds,
    tags,
    sequential,
    locked,
    isShotHidden,
    isShotLocked,
    shotIndex
  }: EditProjectShotRequest,
  work = rendererLibrary.capture()
): Promise<EditedShot> => {
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.patch(
      `/projects/${projectId}/shots/${timelineId}`,
      {
        ...(heading === undefined ? {} : { heading }),
        ...(videoPrompt === undefined ? {} : { video_prompt: videoPrompt }),
        ...(dialogue === undefined ? {} : { dialogue }),
        ...(durationSeconds === undefined
          ? {}
          : { duration_s: durationSeconds }),
        ...(tags ? { tags } : {}),
        ...(sequential === undefined ? {} : { sequential }),
        ...(locked === undefined ? {} : { locked }),
        ...(isShotHidden === undefined ? {} : { hidden: isShotHidden }),
        ...(isShotLocked === undefined ? {} : { locked: isShotLocked }),
        ...(shotIndex === undefined ? {} : { shot_index: shotIndex })
      },
      { signal }
    )
  );
  return EditedShotSchema.parse(response.data);
};
