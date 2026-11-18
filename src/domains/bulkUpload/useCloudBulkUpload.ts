import { trackingUtils } from "@hooks/tracking/trackingUtils";
import { type BulkUploadFileItem, bulkUploadAtom } from "@store/atoms";
import { useToast } from "@store/useToast";
import { getUploadErrorMessage } from "@utils";
import dayjs from "dayjs";
import { useAtom, useStore } from "jotai";
import { useTranslation } from "react-i18next";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { fetchProject } from "../project/fetchProject";
import { type ShotFolderOrShot } from "../project/shotFolders/interface";
import { useProjectShotFolders } from "../project/shotFolders/useProjectShotFolders";
import { useUpdateProjectShotFolders } from "../project/shotFolders/useUpdateProjectShotFolders";
import { useAutoNameProjectFromVideo } from "../project/useAutoNameProjectFromVideo";
import { deleteTimeline } from "../shot/deleteTimeline";
import { postTimeline } from "../shot/postTimeline";
import { putTimeline } from "../shot/putTimeline";
import { UPLOAD_PROGRESS_COMPLETE } from "../videoUpload/constants";
import { IngestPhase } from "../videoUpload/types";
import { useIngestVideo } from "../videoUpload/useIngestVideo";

import { validateVideoFile } from "./utils/getVideoDuration";

const INITIAL_UPLOAD_PROGRESS = 5;

const STATUS_BY_INGEST_PHASE: Partial<
  Record<IngestPhase, BulkUploadFileItem["status"]>
> = {
  uploading: "uploading",
  ingesting: "ingesting",
  finalizing: "completed"
};

type UploadBatch = {
  work: RendererLibraryWork;
  firstFileId: string;
  workingFolders: ShotFolderOrShot[];
  cancelledFiles: Set<string>;
  cancelAll: boolean;
  controllers: Map<string, AbortController>;
};

// The panel and the drop handler may use different instances of this hook.
const batches = new WeakMap<ReturnType<typeof useStore>, UploadBatch>();

const emptyUploadState = {
  isUploadInProgress: false,
  files: [],
  targetFolderId: "",
  isPanelVisible: false
};

type FileUpdates = Partial<
  Pick<BulkUploadFileItem, "status" | "progress" | "errorMessage" | "projectId">
>;

export const useCloudBulkUpload = (projectId: string | undefined) => {
  const { work } = useRendererLibraryWork();
  const { ingestVideo } = useIngestVideo();
  const { data: shotFoldersData } = useProjectShotFolders(projectId);
  const { mutateAsync: updateShotFolders } =
    useUpdateProjectShotFolders(projectId);
  const { autoNameProjectFromVideo } = useAutoNameProjectFromVideo();
  const [bulkUploadState, setBulkUploadState] = useAtom(bulkUploadAtom);
  const store = useStore();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const updateFileStatus = (
    batch: UploadBatch,
    fileId: string,
    updates: FileUpdates
  ) => {
    if (batch.work.signal.aborted || batches.get(store) !== batch) return;
    setBulkUploadState((prev) => ({
      ...prev,
      files: prev.files.map((file) =>
        file.id === fileId ? { ...file, ...updates } : file
      )
    }));
  };

  const processFile = async (
    batch: UploadBatch,
    fileItem: BulkUploadFileItem,
    existingProjectId: string,
    targetFolderId: string,
    totalCount: number,
    emptyTimelineId?: string
  ) => {
    const { work } = batch;
    let createdTimelineId: string | undefined;
    const controller = new AbortController();
    batch.controllers.set(fileItem.id, controller);
    const update = (updates: FileUpdates) =>
      updateFileStatus(batch, fileItem.id, updates);
    const check = () => {
      work.check();
      controller.signal.throwIfAborted();
    };
    const cleanupTimeline = async () => {
      if (work.signal.aborted || !createdTimelineId) return;
      try {
        await deleteTimeline(createdTimelineId, existingProjectId, work);
      } catch (error) {
        if (!work.signal.aborted)
          console.error("Failed to delete timeline:", error);
      }
    };

    try {
      check();
      update({ status: "validating", progress: 0 });
      const validationError = await validateVideoFile(fileItem.file);
      check();
      if (validationError) {
        update({ status: "error", errorMessage: t(validationError) });
        return "error";
      }
      update({ status: "uploading", progress: 0 });

      const timelineName = fileItem.fileName.replace(/\.[^/.]+$/, "");
      let shotId: string;
      if (emptyTimelineId) {
        await putTimeline(
          emptyTimelineId,
          {
            name: timelineName,
            settings: {},
            project_id: existingProjectId
          },
          work
        );
        shotId = emptyTimelineId;
      } else {
        const timeline = await postTimeline(
          existingProjectId,
          timelineName,
          work
        );
        if (!timeline) throw new Error("Failed to create timeline");
        shotId = timeline.id;
        createdTimelineId = shotId;
      }
      check();
      batch.workingFolders = [
        ...batch.workingFolders,
        {
          id: shotId,
          name: timelineName,
          parentFolderId: targetFolderId,
          type: "shot",
          createdAt: dayjs().unix()
        }
      ];
      await updateShotFolders(batch.workingFolders, work);
      check();
      update({
        projectId: existingProjectId,
        progress: INITIAL_UPLOAD_PROGRESS
      });

      const result = await ingestVideo(
        {
          shotId,
          projectId: existingProjectId,
          file: fileItem.file,
          signal: controller.signal,
          awaitInvalidation: false,
          onProgress: ({ phase, progress }) => {
            const status = STATUS_BY_INGEST_PHASE[phase];
            update({ progress, ...(status ? { status } : {}) });
          },
          onUploaded: ({ trackId, trackName }) =>
            trackingUtils.videoActions.upload(trackId, trackName, shotId, "", {
              numberOfVideos: totalCount,
              videoFormats: [
                fileItem.file.type || fileItem.fileName.split(".").pop() || ""
              ]
            })
        },
        work
      );

      check();
      if (result.outcome === "cancelled") {
        await cleanupTimeline();
        return "cancelled";
      }
      update({ status: "completed", progress: UPLOAD_PROGRESS_COMPLETE });
      return "completed";
    } catch (error) {
      await cleanupTimeline();
      if (work.signal.aborted || controller.signal.aborted) return "cancelled";
      const errorKey = getUploadErrorMessage(error);
      update({
        status: "error",
        errorMessage: errorKey.startsWith("upload_button_")
          ? t(`notifications.${errorKey}.description`)
          : t(errorKey)
      });
      return "error";
    } finally {
      batch.controllers.delete(fileItem.id);
    }
  };

  const startBulkUpload = async (
    files: File[],
    existingProjectId: string,
    targetFolderId: string
  ) => {
    if (
      work.signal.aborted ||
      batches.get(store)?.work.signal === work.signal ||
      files.length === 0
    )
      return;
    const fileItems: BulkUploadFileItem[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      fileName: file.name,
      status: "pending",
      progress: 0
    }));
    const batch: UploadBatch = {
      work,
      firstFileId: fileItems[0].id,
      workingFolders: shotFoldersData?.shotFoldersAndShots ?? [],
      cancelledFiles: new Set(),
      cancelAll: false,
      controllers: new Map()
    };
    batches.set(store, batch);
    const onSuspend = () => {
      // Clear only this batch's panel, before replacement; never mutate the
      // atom from a stale continuation or erase a different uploader's UI.
      setBulkUploadState((prev) =>
        prev.files[0]?.id === batch.firstFileId ? emptyUploadState : prev
      );
    };
    work.signal.addEventListener("abort", onSuspend, { once: true });
    try {
      await work.ready();
      work.check();
      setBulkUploadState({
        isUploadInProgress: true,
        files: fileItems,
        targetFolderId,
        isPanelVisible: true
      });
      const project = await fetchProject(existingProjectId, work);
      work.check();
      const emptyTimelineId = project?.timelines?.find(
        (timeline) => timeline.layers.length === 0
      )?.id;
      if (project && !batch.cancelAll) {
        await autoNameProjectFromVideo(project, files[0].name, work);
      }

      let successCount = 0;
      let errorCount = 0;
      for (const [index, item] of fileItems.entries()) {
        work.check();
        if (batch.cancelAll) break;
        if (batch.cancelledFiles.has(item.id)) continue;
        const result = await processFile(
          batch,
          item,
          existingProjectId,
          targetFolderId,
          fileItems.length,
          index === 0 ? emptyTimelineId : undefined
        );
        if (result === "completed") successCount++;
        else if (result === "error") errorCount++;
      }

      work.check();
      if (successCount + errorCount > 0) {
        const message =
          errorCount > 0
            ? t("notifications.bulk_upload_complete_with_errors.description", {
                successCount,
                totalCount: fileItems.length
              })
            : t("notifications.bulk_upload_complete.description", {
                successCount,
                totalCount: fileItems.length
              });
        showToast({ message });
      }
    } catch (error) {
      if (!work.signal.aborted) throw error;
    } finally {
      work.signal.removeEventListener("abort", onSuspend);
      if (batches.get(store) === batch) {
        batches.delete(store);
        if (!work.signal.aborted) {
          setBulkUploadState((prev) =>
            prev.files[0]?.id === batch.firstFileId
              ? { ...prev, isUploadInProgress: false }
              : prev
          );
        }
      }
    }
  };

  const currentBatch = () => {
    const batch = batches.get(store);
    return !work.signal.aborted && batch?.work.signal === work.signal
      ? batch
      : undefined;
  };

  const cancelPendingUpload = (fileId: string) => {
    const batch = currentBatch();
    if (!batch) return;
    batch.cancelledFiles.add(fileId);
    batch.controllers.get(fileId)?.abort();
    updateFileStatus(batch, fileId, { status: "cancelled" });
  };

  const cancelAllUploads = () => {
    const batch = currentBatch();
    if (!batch) return;
    batch.cancelAll = true;
    batch.controllers.forEach((controller) => controller.abort());
    setBulkUploadState((prev) =>
      prev.files[0]?.id === batch.firstFileId
        ? {
            ...prev,
            files: prev.files.map((file) =>
              file.status === "completed" || file.status === "error"
                ? file
                : { ...file, status: "cancelled" }
            )
          }
        : prev
    );
  };

  const hideBulkUploadPanel = () => {
    if (!work.signal.aborted) setBulkUploadState(emptyUploadState);
  };

  return {
    bulkUploadState,
    startBulkUpload,
    cancelPendingUpload,
    cancelAllUploads,
    hideBulkUploadPanel
  };
};
