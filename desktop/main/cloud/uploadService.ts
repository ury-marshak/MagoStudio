import { unlink } from "node:fs/promises";
import path from "node:path";

import { normalizeSourceVideoTrim } from "../../shared/normalizeSourceVideoTrim";
import { LibraryWorkSession } from "../libraryWorkSession";

import {
  cloudImageCachePath,
  type CloudImageFile,
  type CloudImageInput,
  prepareCloudImageFile
} from "./cloudImageFile";
import { encodeUploadCacheFile, readFreshUploadSize } from "./uploadCacheFile";
import {
  buildUploadEncodeArgs,
  uploadCachePath,
  uploadCachePathBeforeTrimWasKeyed
} from "./uploadEncode";
import {
  uploadBytesToPresignedUrl,
  uploadFileToPresignedUrl
} from "./uploadFile";

const UPLOAD_CONTENT_TYPE = "video/mp4";

type Progress = (fraction: number) => void;
type ByteUpload = { controller: AbortController; transfer?: Promise<void> };

export interface PreparedUpload {
  /** Absolute path of the encoded file, inside the library. */
  filePath: string;
  relativePath: string;
  sizeBytes: number;
  /** False when a cached encode was reused. */
  encoded: boolean;
}

/** Owns local preparation and presigned transfers, not provider jobs. */
export class UploadService {
  readonly libraryWork = new LibraryWorkSession(() => ({
    preparations: new Map<string, Promise<void>>(),
    byteUploads: new WeakMap<object, Map<string, Set<ByteUpload>>>()
  }));

  constructor(private readonly getLibraryRoot: () => Promise<string | null>) {}

  /** Encodes to the shape that makes cloud ingestion a stream copy. */
  async prepare(input: {
    assetId: string;
    sourcePath: string;
    trimStartSeconds?: number;
    trimEndSeconds?: number;
    force?: boolean;
  }): Promise<PreparedUpload> {
    const work = this.libraryWork;
    return work.run(async () => {
      const signal = work.capture();
      const root = await work.boundary(this.getLibraryRoot);
      if (!root) throw new Error("Choose a Mago library folder first");
      const trim = normalizeSourceVideoTrim(input);
      const relativePath = uploadCachePath({ assetId: input.assetId, ...trim });
      const filePath = path.join(root, relativePath);
      return this.prepareInOrder(filePath, async () => {
        if (!input.force) {
          const sizeBytes = await readFreshUploadSize(
            filePath,
            input.sourcePath,
            signal
          );
          if (sizeBytes)
            return { filePath, relativePath, sizeBytes, encoded: false };
        }
        const sizeBytes = await encodeUploadCacheFile({
          destination: filePath,
          args: (temporary) =>
            buildUploadEncodeArgs({
              sourcePath: input.sourcePath,
              outputPath: temporary,
              ...trim
            }),
          signal,
          message: "Unable to prepare the video for upload",
          // Large videos may legitimately take over a minute. Library teardown
          // still kills and drains the local child.
          timeoutMs: null
        });
        signal.throwIfAborted();
        await unlink(
          path.join(root, uploadCachePathBeforeTrimWasKeyed(input.assetId))
        ).catch(() => {});
        return { filePath, relativePath, sizeBytes, encoded: true };
      });
    });
  }

  async prepareImage(input: CloudImageInput): Promise<CloudImageFile> {
    return this.libraryWork.run(() => {
      const signal = this.libraryWork.capture();
      return this.prepareInOrder(cloudImageCachePath(input), () =>
        prepareCloudImageFile(input, signal)
      );
    });
  }

  /** Serialize writers of one cache path without sharing force decisions or
   * keeping an unstarted task in the library drain. */
  private async prepareInOrder<Result>(
    filePath: string,
    prepare: () => Promise<Result>
  ): Promise<Result> {
    const work = this.libraryWork;
    const { preparations } = work.state;
    const result = (preparations.get(filePath) ?? Promise.resolve()).then(() =>
      work.boundary(prepare)
    );
    const settled = result.then(
      () => {},
      () => {}
    );
    preparations.set(filePath, settled);
    try {
      return await result;
    } finally {
      if (preparations.get(filePath) === settled) preparations.delete(filePath);
    }
  }

  async upload(input: {
    filePath: string;
    presignedUrl: string;
    contentType?: string;
    onProgress?: Progress;
    assertAccess?: () => Promise<void>;
  }): Promise<void> {
    return this.libraryWork.run(() => {
      const signal = this.libraryWork.capture();
      return this.transfer(signal, input.onProgress, (onProgress) =>
        uploadFileToPresignedUrl({
          ...input,
          contentType: input.contentType ?? UPLOAD_CONTENT_TYPE,
          signal,
          onProgress
        })
      );
    });
  }

  async uploadBytes(
    owner: object,
    input: {
      uploadId: string;
      bytes: Buffer;
      presignedUrl: string;
      contentType: string;
      onProgress?: Progress;
      assertAccess: () => Promise<void>;
    }
  ): Promise<void> {
    const work = this.libraryWork;
    return work.run(async () => {
      const { byteUploads } = work.state;
      const uploads =
        byteUploads.get(owner) ?? new Map<string, Set<ByteUpload>>();
      byteUploads.set(owner, uploads);
      const attempts = uploads.get(input.uploadId) ?? new Set<ByteUpload>();
      uploads.set(input.uploadId, attempts);
      const entry: ByteUpload = { controller: new AbortController() };
      const signal = AbortSignal.any([work.signal, entry.controller.signal]);
      // Register before the permission wait so immediate cancellation cannot
      // miss this attempt. Pending permission isn't issued media work.
      attempts.add(entry);
      try {
        await input.assertAccess();
        signal.throwIfAborted();
        for (const older of attempts) {
          if (older === entry) break;
          older.controller.abort();
        }
        entry.transfer = this.transfer(signal, input.onProgress, (onProgress) =>
          uploadBytesToPresignedUrl({ ...input, signal, onProgress })
        );
        await entry.transfer;
      } finally {
        attempts.delete(entry);
        if (attempts.size === 0) uploads.delete(input.uploadId);
      }
    });
  }

  async cancelUploadBytes(owner: object, uploadId: string): Promise<void> {
    const work = this.libraryWork;
    return work.run(async () => {
      const attempts = [
        ...(work.state.byteUploads.get(owner)?.get(uploadId) ?? [])
      ];
      const issued: Promise<void>[] = [];
      for (const attempt of attempts) {
        attempt.controller.abort();
        if (attempt.transfer) issued.push(attempt.transfer);
      }
      // Superseded transfers can still be closing. Acknowledge only after ALL
      // issued transfers for this ID have drained, even when they reject.
      await Promise.allSettled(issued);
    });
  }

  private async transfer(
    signal: AbortSignal,
    listener: Progress | undefined,
    issue: (progress: Progress) => Promise<void>
  ): Promise<void> {
    let active = true;
    try {
      signal.throwIfAborted();
      await this.libraryWork.boundary(() =>
        issue((fraction) => {
          if (active && !signal.aborted) listener?.(fraction);
        })
      );
      signal.throwIfAborted();
    } finally {
      active = false;
    }
  }
}
