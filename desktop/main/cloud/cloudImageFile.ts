import path from "node:path";

import { contentTypeForExtension } from "./localAssetInfo";
import { encodeUploadCacheFile, readFreshUploadSize } from "./uploadCacheFile";

const CLOUD_ACCEPTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);
const CLOUD_CONVERTED_IMAGE_EXTENSION = "png";
const CLOUD_IMAGE_CACHE_DIRECTORY = path.join("cloud", "images");

export interface CloudImageFile {
  filePath: string;
  extension: string;
  contentType: string;
}

export interface CloudImageInput {
  assetId: string;
  sourcePath: string;
  extension: string;
  libraryRoot: string;
}

export const isCloudAcceptedImageExtension = (extension: string): boolean =>
  CLOUD_ACCEPTED_IMAGE_EXTENSIONS.has(extension.toLowerCase());

export const cloudImageCachePath = (input: CloudImageInput): string =>
  path.join(
    input.libraryRoot,
    CLOUD_IMAGE_CACHE_DIRECTORY,
    `${input.assetId}.${CLOUD_CONVERTED_IMAGE_EXTENSION}`
  );

export const buildPngConversionArgs = (
  sourcePath: string,
  outputPath: string
): string[] => [
  "-hide_banner",
  "-loglevel",
  "error",
  "-nostdin",
  "-y",
  "-i",
  sourcePath,
  "-frames:v",
  "1",
  "-c:v",
  "png",
  "-f",
  "image2",
  outputPath
];

export const prepareCloudImageFile = async (
  input: CloudImageInput,
  signal?: AbortSignal
): Promise<CloudImageFile> => {
  signal?.throwIfAborted();
  const extension = input.extension.toLowerCase();
  if (isCloudAcceptedImageExtension(extension)) {
    return {
      filePath: input.sourcePath,
      extension,
      contentType: contentTypeForExtension(extension)
    };
  }

  const outputPath = cloudImageCachePath(input);
  if (!(await readFreshUploadSize(outputPath, input.sourcePath, signal))) {
    await encodeUploadCacheFile({
      destination: outputPath,
      args: (temporary) => buildPngConversionArgs(input.sourcePath, temporary),
      signal,
      message: "Unable to convert the image for cloud Mago"
    });
  }
  signal?.throwIfAborted();
  return {
    filePath: outputPath,
    extension: CLOUD_CONVERTED_IMAGE_EXTENSION,
    contentType: contentTypeForExtension(CLOUD_CONVERTED_IMAGE_EXTENSION)
  };
};
