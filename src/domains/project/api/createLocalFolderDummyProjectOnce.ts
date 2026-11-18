import { Project, ProjectSchema } from "@schemas/project";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { LOCAL_FOLDER_DUMMY_PROJECT_DESCRIPTION } from "../../../../desktop/shared/localFolderDummyProject";

const FOLDER_DUMMY_PROJECT_RANGE_MIN = 0;
const FOLDER_DUMMY_PROJECT_RANGE_MAX = 48;

const creations = new WeakMap<AbortSignal, Promise<Project>>();

export const createLocalFolderDummyProjectOnce = async (
  userId: string,
  work = rendererLibrary.capture()
): Promise<Project> => {
  work.check();
  let creation = creations.get(work.signal);
  if (!creation) {
    creation = work
      .boundary(async () =>
        ProjectSchema.parse(
          await getLocalDesktopApi().projects.create({
            name: userId,
            description: LOCAL_FOLDER_DUMMY_PROJECT_DESCRIPTION,
            settings: {
              rangeMin: FOLDER_DUMMY_PROJECT_RANGE_MIN,
              rangeMax: FOLDER_DUMMY_PROJECT_RANGE_MAX,
              folders: []
            }
          })
        )
      )
      .catch((error: unknown) => {
        creations.delete(work.signal);
        throw error;
      });
    creations.set(work.signal, creation);
  }
  const project = await creation;
  work.check();
  return project;
};
