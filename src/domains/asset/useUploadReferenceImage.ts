import { useIsReferenceImageUploading } from "@context/IsReferenceImageUploading";
import { ImageAssetResponse } from "@domains/asset/api/interface";
import { useQueryClient } from "@tanstack/react-query";
import { getImageDimensions, resizeImageToFitWidth } from "@utils";
import { useRef, useState } from "react";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { createRendererObjectUrl } from "@/platform/rendererObjectUrl";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

const THUMBNAIL_WIDTH = 158;
const INITIAL_PROGRESS = 5;
const COMPLETE_PROGRESS = 100;
const PROGRESS_RESET_DELAY_MS = 300;

// All hooks sharing a provider contribute to the same pending count.
type SetUploading = (uploading: boolean) => void;
const sharedUploads = new WeakMap<
  SetUploading,
  { signal: AbortSignal; count: number }
>();

const createAbortError = () => new DOMException("Upload aborted", "AbortError");

/**
 * The cloud hook's interface (cancellable, progress-reporting, several uploads
 * at once; `selectedLayerId` is accepted and unused), with the upload replaced: the image is imported into the
 * local library from its path on disk instead of being put to S3.
 */
export const useUploadReferenceImage = () => {
  const queryClient = useQueryClient();
  const { work: origin } = useRendererLibraryWork();
  const [progress, setProgress] = useState<{
    signal: AbortSignal;
    value: number;
  }>();
  const [failure, setFailure] = useState<{
    signal: AbortSignal;
    error: Error;
  }>();
  const { isReferenceImageUploading, setIsReferenceImageUploading } =
    useIsReferenceImageUploading();
  const latestAttempt = useRef<object>(null);

  const uploadReferenceImage = async ({
    file,
    projectId,
    signal,
    onProgress,
    onError,
    work = origin
  }: {
    file: File;
    selectedLayerId?: string;
    projectId?: string;
    signal?: AbortSignal;
    work?: RendererLibraryWork;
    onProgress?: (progress: number) => void;
    onError?: (error: unknown) => void;
  }): Promise<string | undefined> => {
    if (!projectId) {
      throw new Error("Project ID is required");
    }

    work.check();
    const attempt = {};
    latestAttempt.current = attempt;
    const reportProgress = (value: number) => {
      work.check();
      if (latestAttempt.current === attempt)
        setProgress({ signal: work.signal, value });
      onProgress?.(value);
    };

    const previous = sharedUploads.get(setIsReferenceImageUploading);
    const uploads =
      previous?.signal === work.signal
        ? previous
        : { signal: work.signal, count: 0 };
    sharedUploads.set(setIsReferenceImageUploading, uploads);
    uploads.count += 1;
    setIsReferenceImageUploading(true);
    let tracking = true;
    const finish = () => {
      if (!tracking) return;
      tracking = false;
      if (
        --uploads.count === 0 &&
        sharedUploads.get(setIsReferenceImageUploading) === uploads
      ) {
        sharedUploads.delete(setIsReferenceImageUploading);
        setIsReferenceImageUploading(false);
      }
    };
    work.signal.addEventListener("abort", finish, { once: true });
    try {
      reportProgress(0);
      await work.ready();
      const dimensions = await getImageDimensions(file);
      reportProgress(INITIAL_PROGRESS);

      const sourcePath = getLocalDesktopApi().files.getPath(file);
      if (!sourcePath) {
        throw new Error("upload_button_file_access_error");
      }
      const thumbnail = await resizeImageToFitWidth(file, THUMBNAIL_WIDTH);
      work.check();
      const thumbnailDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () =>
          reject(new Error("Unable to read image thumbnail"));
        reader.onload = () => {
          if (typeof reader.result !== "string") {
            reject(new Error("Unable to read image thumbnail"));
            return;
          }
          resolve(reader.result);
        };
        reader.readAsDataURL(thumbnail);
      });
      // User cancellation is honored up to dispatch. Library teardown also
      // drains an issued local import and suppresses its renderer settlement.
      const asset = await work.boundary(() => {
        if (signal?.aborted) throw createAbortError();
        return getLocalDesktopApi().assets.importImage({
          projectId,
          sourcePath,
          name: file.name,
          width: dimensions.width,
          height: dimensions.height,
          thumbnailDataUrl
        });
      });
      work.check();
      queryClient.setQueryData<ImageAssetResponse>(
        libraryQueryKey(queryKeys.imageAsset.byId(asset.id)),
        {
          s3_url: asset.filepath,
          urlToUse: createRendererObjectUrl(file, work),
          asset: asset as ImageAssetResponse["asset"]
        }
      );

      reportProgress(COMPLETE_PROGRESS);
      setTimeout(() => {
        if (!work.signal.aborted && latestAttempt.current === attempt)
          setProgress({ signal: work.signal, value: 0 });
      }, PROGRESS_RESET_DELAY_MS);
      return asset.id;
    } catch (caughtError) {
      work.check();
      console.error(caughtError);
      if (latestAttempt.current === attempt)
        setFailure({ signal: work.signal, error: caughtError as Error });
      reportProgress(0);
      onError?.(caughtError);
      throw caughtError;
    } finally {
      work.signal.removeEventListener("abort", finish);
      finish();
    }
  };

  return {
    mutateAsync: uploadReferenceImage,
    isPending: isReferenceImageUploading,
    uploadProgress:
      !origin.signal.aborted && progress?.signal === origin.signal
        ? progress.value
        : 0,
    error:
      !origin.signal.aborted && failure?.signal === origin.signal
        ? failure.error
        : null
  };
};
