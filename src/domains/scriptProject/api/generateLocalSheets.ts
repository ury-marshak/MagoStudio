import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import {
  isLocalSheetRenderModel,
  LOCAL_SHEET_RENDER_MODEL
} from "../constants";

export const generateLocalSheets = (
  request: Parameters<
    ReturnType<typeof getLocalDesktopApi>["scriptProjects"]["generateSheets"]
  >[0],
  work: RendererLibraryWork
) => {
  const issue = () =>
    getLocalDesktopApi().scriptProjects.generateSheets(request);
  const model = request.settings?.render_model;
  // A live Flux run can wait on a Comfy model probe. Main already owns its
  // repository boundaries; renderer acknowledgement must not wait on the probe.
  return !request.isDryRun &&
    isLocalSheetRenderModel(model) &&
    model !== LOCAL_SHEET_RENDER_MODEL
    ? runRendererLibraryRequest(work, issue)
    : work.boundary(issue);
};
