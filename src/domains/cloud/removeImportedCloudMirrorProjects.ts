import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import type { LocalProjectListItem } from "../../../desktop/shared/contracts";

import { fetchIsCloudMirrorProject } from "./fetchIsCloudMirrorProject";

export const removeImportedCloudMirrorProjects = async ({
  libraryProjects,
  catalogCloudProjectIds,
  signal,
  work = rendererLibrary.capture()
}: {
  libraryProjects: LocalProjectListItem[];
  catalogCloudProjectIds: ReadonlySet<string>;
  signal: AbortSignal;
  work?: RendererLibraryWork;
}): Promise<void> => {
  await work.ready();
  if (signal.aborted) return;
  const desktop = getLocalDesktopApi();
  const importedCloudProjectsMissingFromCatalog = libraryProjects.filter(
    (project) =>
      project.origin === "cloud" && !catalogCloudProjectIds.has(project.id)
  );
  for (const project of importedCloudProjectsMissingFromCatalog) {
    if (signal.aborted) return;
    if (!(await fetchIsCloudMirrorProject(project.id, signal))) continue;
    if (signal.aborted) return;
    await work.boundary(() => desktop.projects.delete(project.id));
  }
};
