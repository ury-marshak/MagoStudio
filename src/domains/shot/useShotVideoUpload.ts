import { trackingUtils } from "@hooks/tracking/trackingUtils";
import { useMountEffect } from "@hooks/useMountEffect";
import { TrimMetadata } from "@schemas/video";
import { useIsSettingsEditorOpenAtom } from "@store/atoms";
import { getUploadErrorMessage } from "@utils";
import { useSetAtom } from "jotai";
import { ChangeEvent, useRef, useState } from "react";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { useSelectedProjectId } from "../project/useSelectedProjectId";
import { useIngestVideo } from "../videoUpload/useIngestVideo";

import { useSelectedShot } from "./useSelectedShot";

export const useShotVideoUpload = () => {
  const selectedProjectId = useSelectedProjectId();
  const { data: selectedShot } = useSelectedShot();
  const setIsSettingsEditorOpen = useSetAtom(useIsSettingsEditorOpenAtom());
  const { ingestVideo } = useIngestVideo();
  const { work } = useRendererLibraryWork();

  const [displayOwner, setDisplayOwner] = useState<AbortSignal>();
  const [error, setError] = useState<string>();
  const [uploadProgress, setUploadProgress] = useState(0);
  const active = useRef<{
    owner: AbortSignal;
    controller: AbortController;
  } | null>(null);
  const ownsDisplay = displayOwner === work.signal && !work.signal.aborted;

  useMountEffect(() => () => active.current?.controller.abort());

  async function handleUpload({
    e,
    trimMetadata,
    processedFile
  }: {
    e: ChangeEvent<HTMLInputElement>;
    trimMetadata?: TrimMetadata;
    processedFile?: File;
  }) {
    if (work.signal.aborted || active.current?.owner === work.signal) return;
    const selectedFile = processedFile ?? e.target.files?.[0];
    if (!selectedFile || !selectedShot?.id || !selectedProjectId) return;

    const controller = new AbortController();
    const attempt = { owner: work.signal, controller };
    active.current = attempt;
    setDisplayOwner(work.signal);
    setUploadProgress(0);
    setError(undefined);

    try {
      const result = await ingestVideo(
        {
          shotId: selectedShot.id,
          projectId: selectedProjectId,
          file: selectedFile,
          trimMetadata,
          signal: controller.signal,
          onProgress: ({ progress }) => setUploadProgress(progress),
          onUploaded: ({ trackId, trackName }) =>
            trackingUtils.videoActions.upload(
              trackId,
              trackName,
              selectedShot.id,
              selectedShot.user_id || ""
            )
        },
        work
      );

      work.check();
      if (!controller.signal.aborted && result.outcome === "ingested") {
        setIsSettingsEditorOpen(true);
      }
    } catch (err) {
      if (!work.signal.aborted && !controller.signal.aborted) {
        setError(getUploadErrorMessage(err));
      }
    } finally {
      if (active.current === attempt) active.current = null;
    }
  }

  return {
    uploadProgress: ownsDisplay ? uploadProgress : 0,
    error: ownsDisplay ? error : undefined,
    handleUpload
  };
};
