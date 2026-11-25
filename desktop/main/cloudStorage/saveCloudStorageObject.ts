import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import { publishFile } from "../storage/atomicFile";

import type { FetchCloudStorage } from "./fetchCloudStorageObject";
import { withCloudStorageDownload } from "./openCloudStorageDownload";

export const saveCloudStorageObject = async ({
  url,
  allowedHosts,
  destinationPath,
  assertAccess,
  fetchFromCloudStorage,
  signal
}: {
  url: unknown;
  allowedHosts: readonly string[];
  destinationPath: string;
  assertAccess?: () => Promise<void>;
  fetchFromCloudStorage?: FetchCloudStorage;
  signal?: AbortSignal;
}): Promise<void> => {
  const partialPath = `${destinationPath}.${randomUUID()}.partial`;
  try {
    await withCloudStorageDownload(
      { url, allowedHosts, assertAccess, fetchFromCloudStorage, signal },
      ({ body }) => pipeline(body, createWriteStream(partialPath), { signal })
    );
    // The body and file writer are closed before publication. Once the
    // rename succeeds, cancellation cannot retract the completed export.
    await publishFile(partialPath, destinationPath, signal);
  } catch (error) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
};
