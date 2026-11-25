import { readMediaBlob } from "@domains/asset/utils/readMediaBlob";
import { useProject } from "@domains/project/useProject";
import { triggerBlobDownload } from "@hooks/files/utils";
import { CutShot } from "@schemas/scriptProject";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { fetchRendererMedia } from "@/platform/rendererMediaAccess";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { postProjectCutExport } from "./api/postProjectCutExport";
import { useProjectCutExportDryRun } from "./data/useProjectCutExportDryRun";
import { useDownloadCut } from "./useDownloadCut";
import { buildCutExportFileName } from "./utils/buildCutExportFileName";
import {
  CutExportRefusalDescription,
  describeCutExportRefusal
} from "./utils/describeCutExportRefusal";
import { waitForCutExportUrl } from "./utils/waitForCutExportUrl";

/** Download the cut as one MP4, offering the per-shot ZIP when it cannot be stitched.
 *
 * The stitch is a stream copy, so the backend refuses any cut whose pinned videos disagree on
 * size or fps — a partly-upscaled cut, which is an ordinary state rather than a fault. The dry
 * run reports that before the user presses anything; a failure that only appears mid-export
 * opens the dialog instead, because quietly handing back a different format than the button
 * promised is worse than asking. */
export const useExportCut = (
  projectId: string,
  cutShots: CutShot[],
  cutExportUrl: string | null | undefined
) => {
  const queryClient = useQueryClient();
  const { data: project } = useProject(projectId);
  const { work } = useRendererLibraryWork();
  const [exporting, setExporting] = useState<AbortSignal | null>(null);
  const [failure, setFailure] = useState<{
    signal: AbortSignal;
    description: CutExportRefusalDescription;
  } | null>(null);
  const setFailedExport = (description: CutExportRefusalDescription | null) => {
    if (!work.signal.aborted) {
      setFailure(description ? { signal: work.signal, description } : null);
    }
  };
  const {
    downloadCut: downloadCutAsZip,
    downloadOneShot,
    isDownloadingCut,
    downloadableShotCount
  } = useDownloadCut(cutShots, project?.name);

  const { data: exportDryRun } = useProjectCutExportDryRun(projectId);
  const expectedRefusal = describeCutExportRefusal(exportDryRun?.refused);

  const downloadStitchedFile = async (url: string) => {
    await work.ready();
    work.check();
    const response = await fetchRendererMedia(url, { signal: work.signal });
    const blob = await readMediaBlob(response, work.signal);
    work.check();
    triggerBlobDownload(blob, buildCutExportFileName(project?.name, "mp4"));
  };

  const exportCut = async () => {
    if (work.signal.aborted || downloadableShotCount === 0) return;
    setExporting(work.signal);

    try {
      const dispatch = await postProjectCutExport(
        { projectId, isDryRun: false },
        work
      );
      work.check();

      const refusal = describeCutExportRefusal(dispatch.refused);
      if (refusal) {
        setFailedExport(refusal);
        return;
      }

      if (dispatch.reused && cutExportUrl) {
        await downloadStitchedFile(cutExportUrl);
        return;
      }

      if (!dispatch.plan_id) {
        setFailedExport({
          labelKey: "script_project.export_unavailable.label",
          shotNumbers: []
        });
        return;
      }

      const stitchedUrl = await waitForCutExportUrl({
        projectId,
        planId: dispatch.plan_id,
        work
      });
      work.check();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectCut.byProjectId(projectId)
      });

      if (!stitchedUrl) {
        setFailedExport({
          labelKey: "script_project.export_timed_out.label",
          shotNumbers: []
        });
        return;
      }

      await downloadStitchedFile(stitchedUrl);
    } catch {
      setFailedExport({
        labelKey: "script_project.export_failed_reason.label",
        shotNumbers: []
      });
    } finally {
      if (!work.signal.aborted) setExporting(null);
    }
  };

  /* A cut the dry run already refused is not asked to stitch: the answer is known, so the
   * button goes straight to the separate files rather than spending a request to be told no
   * and then opening a dialog about it. */
  const downloadCut = async () => {
    if (work.signal.aborted) return;
    return expectedRefusal ? downloadCutAsZip() : exportCut();
  };

  return {
    downloadCut,
    downloadOneShot,
    downloadCutAsZipAndDismiss: async () => {
      if (work.signal.aborted) return;
      await downloadCutAsZip();
      setFailedExport(null);
    },
    isExportingCut:
      (!work.signal.aborted && exporting === work.signal) || isDownloadingCut,
    isDownloadingCut,
    downloadableShotCount,
    /** Known from the dry run, before the user presses anything. */
    expectedRefusal,
    failedExport:
      !work.signal.aborted && failure?.signal === work.signal
        ? failure.description
        : null,
    dismissFailedExport: () => setFailedExport(null)
  };
};
