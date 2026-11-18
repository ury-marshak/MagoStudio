import { trackingUtils } from "@hooks/tracking/trackingUtils";
import { useMountEffect } from "@hooks/useMountEffect";
import { TrimMetadata } from "@schemas/video";
import { getUploadErrorMessage } from "@utils";
import { ChangeEvent, useRef, useState } from "react";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { PROJECT_NAME_MAX_LENGTH } from "../project/constants";
import { fetchProject } from "../project/fetchProject";
import { useAutoNameProjectFromVideo } from "../project/useAutoNameProjectFromVideo";
import { useCreateNewProject } from "../project/useCreateNewProject";
import { useDeleteProject } from "../project/useDeleteProject";
import { useIngestVideo } from "../videoUpload/useIngestVideo";

import { deleteTimeline } from "./api/deleteTimeline";
import { postTimeline } from "./api/postTimeline";
import { putTimeline } from "./api/putTimeline";

interface UseCreateProjectAndUploadVideoParams {
  onSuccess?: (projectId: string, shotId: string) => void;
  existingProjectId?: string;
  parentFolderId?: string;
}

interface UploadAttempt {
  work: RendererLibraryWork;
  controller: AbortController;
  newProjectId?: string;
  newTimelineId?: string;
  existingProjectId?: string;
  cancelRequested?: boolean;
  cleanup?: Promise<unknown>;
}

const getTimelineNameFromFile = (file: File) =>
  file.name.replace(/\.[^/.]+$/, "").slice(0, PROJECT_NAME_MAX_LENGTH) ||
  "Untitled";

export const useCreateProjectAndUploadVideo = ({
  onSuccess,
  existingProjectId,
  parentFolderId
}: UseCreateProjectAndUploadVideoParams = {}) => {
  const { createNewProject } = useCreateNewProject();
  const { mutateAsync: deleteProject } = useDeleteProject();
  const { autoNameProjectFromVideo } = useAutoNameProjectFromVideo();
  const { ingestVideo } = useIngestVideo();
  const { work } = useRendererLibraryWork();

  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [displayOwner, setDisplayOwner] = useState<AbortSignal>();
  const active = useRef<UploadAttempt | null>(null);
  const ownsDisplay = displayOwner === work.signal && !work.signal.aborted;

  useMountEffect(() => () => active.current?.controller.abort());

  const cleanup = async (attempt: UploadAttempt) => {
    if (attempt.work.signal.aborted) return;
    if (!attempt.cleanup) {
      if (attempt.newProjectId) {
        attempt.cleanup = deleteProject(
          { projectId: attempt.newProjectId },
          attempt.work
        );
      } else if (attempt.cancelRequested && attempt.newTimelineId) {
        attempt.cleanup = deleteTimeline(
          attempt.newTimelineId,
          attempt.existingProjectId,
          attempt.work
        );
      }
    }
    try {
      await attempt.cleanup;
    } catch (error) {
      if (!attempt.work.signal.aborted && !attempt.cancelRequested) {
        console.error("Failed to delete project after upload error:", error);
      }
    }
  };

  const handleUpload = async ({
    e,
    trimMetadata,
    processedFile
  }: {
    e: ChangeEvent<HTMLInputElement>;
    trimMetadata?: TrimMetadata;
    processedFile?: File;
  }) => {
    if (work.signal.aborted || active.current?.work.signal === work.signal)
      return;
    const originalFile = e.target.files?.[0];
    const selectedFile = processedFile ?? originalFile;
    if (!selectedFile) return;

    const controller = new AbortController();
    const attempt: UploadAttempt = { work, controller, existingProjectId };
    active.current = attempt;
    setDisplayOwner(work.signal);
    setUploadProgress(0);
    setError(null);
    setIsUploading(true);

    const check = () => {
      work.check();
      controller.signal.throwIfAborted();
    };

    try {
      await work.ready();
      check();
      let projectId: string;
      let shotId: string;
      const namingFile = originalFile ?? selectedFile;
      const timelineName = getTimelineNameFromFile(namingFile);

      if (existingProjectId) {
        projectId = existingProjectId;
        const existingProject = await fetchProject(projectId, work);
        check();
        const emptyTimeline = existingProject?.timelines?.find(
          (timeline) => timeline.layers.length === 0
        );

        if (emptyTimeline) {
          await putTimeline(
            emptyTimeline.id,
            {
              name: timelineName,
              settings: {},
              project_id: projectId
            },
            work
          );
          shotId = emptyTimeline.id;
        } else {
          const newTimeline = await postTimeline(projectId, timelineName, work);
          shotId = newTimeline.id;
          attempt.newTimelineId = shotId;
        }
        check();
        if (existingProject) {
          await autoNameProjectFromVideo(
            existingProject,
            namingFile.name,
            work
          );
        }
      } else {
        const newProject = await createNewProject({ parentFolderId }, work);
        if (!newProject) throw new Error("Failed to create project");

        projectId = newProject.id;
        attempt.newProjectId = projectId;
        check();
        shotId = newProject.timelines?.[0]?.id ?? "";
        if (!shotId) throw new Error("No shot found in created project");

        await putTimeline(
          shotId,
          {
            name: timelineName,
            settings: {},
            project_id: projectId
          },
          work
        );
        check();
        await autoNameProjectFromVideo(newProject, namingFile.name, work);
      }
      check();

      const result = await ingestVideo(
        {
          shotId,
          projectId,
          file: selectedFile,
          trimMetadata,
          signal: controller.signal,
          onProgress: ({ progress }) => setUploadProgress(progress),
          onUploaded: ({ trackId, trackName }) =>
            trackingUtils.videoActions.upload(trackId, trackName, shotId, "")
        },
        work
      );

      check();
      if (result.outcome === "ingested") onSuccess?.(projectId, shotId);
    } catch (error) {
      if (work.signal.aborted) return;
      if (controller.signal.aborted) {
        if (attempt.cancelRequested) await cleanup(attempt);
        return;
      }
      console.error("Error in upload flow:", error);
      await cleanup(attempt);
      if (!work.signal.aborted && !controller.signal.aborted) {
        setError(getUploadErrorMessage(error));
      }
    } finally {
      if (active.current === attempt) {
        active.current = null;
        if (!work.signal.aborted) setIsUploading(false);
      }
    }
  };

  const clearError = () => {
    if (work.signal.aborted) return;
    setError(null);
    setUploadProgress(0);
  };

  const cancelUpload = async () => {
    const attempt = active.current;
    if (work.signal.aborted) return false;
    if (!attempt || attempt.work.signal !== work.signal) return true;
    attempt.cancelRequested = true;
    attempt.controller.abort();
    await cleanup(attempt);
    if (work.signal.aborted || (active.current && active.current !== attempt))
      return false;
    setIsUploading(false);
    clearError();
    return true;
  };

  return {
    handleUpload,
    uploadProgress: ownsDisplay ? uploadProgress : 0,
    error: ownsDisplay ? error : null,
    isUploading: ownsDisplay && isUploading,
    clearError,
    cancelUpload
  };
};
