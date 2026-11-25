import { zipBlobs } from "@app/services/zip/zipBlobs";
import { fetchFileBypassingPlaybackCache } from "@app/utils/files/fetchFileBypassingPlaybackCache";
import { triggerBlobDownload } from "@hooks/files/utils";
import { CutShot } from "@schemas/scriptProject";
import { useToast } from "@store/useToast";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { buildCutDownloadName } from "./utils/buildCutDownloadNames";
import { buildCutExportFileName } from "./utils/buildCutExportFileName";

export const useDownloadCut = (
  cutShots: CutShot[],
  projectName?: string | null
) => {
  const { t } = useTranslation();
  const { showErrorToast } = useToast();
  const { work } = useRendererLibraryWork();
  const [downloadingWork, setDownloadingWork] = useState<typeof work | null>(
    null
  );

  const downloadableShots = cutShots.filter((cutShot) => !!cutShot.url);

  /* Checked rather than assumed: a signed asset URL expires, and a 403's XML body saved under a
   * shot's name is a file the user cannot play and cannot diagnose. */
  const fetchShotVideo = async (url: string): Promise<Response> => {
    work.check();
    const response = await fetchFileBypassingPlaybackCache(url, work.signal);
    work.check();
    if (!response.ok) {
      throw new Error(
        `Downloading a shot failed with status ${response.status}`
      );
    }
    if (
      response.headers
        ?.get("content-type")
        ?.toLowerCase()
        .startsWith("text/html")
    ) {
      throw new Error("Downloading a shot returned HTML instead of video");
    }
    return response;
  };

  const downloadOneShot = async (cutShot: CutShot) => {
    if (!cutShot.url || work.signal.aborted) return;
    try {
      await work.ready();
      const response = await fetchShotVideo(cutShot.url);
      const blob = await response.blob();
      work.check();
      triggerBlobDownload(blob, buildCutDownloadName(cutShot));
    } catch {
      if (work.signal.aborted) return;
      showErrorToast({
        message: t("script_project.download_shot_failed.label"),
        onRetry: () => void downloadOneShot(cutShot)
      });
    }
  };

  const downloadCut = async () => {
    if (downloadableShots.length === 0 || work.signal.aborted) return;
    setDownloadingWork(work);
    try {
      await work.ready();
      const entries = await Promise.all(
        downloadableShots.map(async (cutShot) => {
          const response = await fetchShotVideo(cutShot.url!);
          const data = new Uint8Array(await response.arrayBuffer());
          work.check();
          return { name: buildCutDownloadName(cutShot), data };
        })
      );
      work.check();
      const zip = await zipBlobs(entries);
      work.check();
      triggerBlobDownload(zip, buildCutExportFileName(projectName, "zip"));
    } catch {
      if (work.signal.aborted) return;
      showErrorToast({
        message: t("script_project.download_cut_failed.label"),
        onRetry: () => void downloadCut()
      });
    } finally {
      if (!work.signal.aborted) setDownloadingWork(null);
    }
  };

  return {
    downloadCut,
    downloadOneShot,
    isDownloadingCut: downloadingWork === work && !work.signal.aborted,
    downloadableShotCount: downloadableShots.length
  };
};
