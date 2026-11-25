import { unlink } from "node:fs/promises";
import path from "node:path";

import { normalizeSourceVideoTrim } from "../../shared/normalizeSourceVideoTrim";
import { LibraryWorkSession } from "../libraryWorkSession";
import type { ProfileIoDrain } from "../providers/profileIoDrain";

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

  constructor(
    private readonly getLibraryRoot: () => Promise<string | null>,
    private readonly profileIo?: ProfileIoDrain
  ) {}

  /** Encodes to the shape that makes cloud ingestion a stream copy. */
  async prepare(input: {
    assetId: string;
    sourcePath: string;
    trimStartSeconds?: number;
    trimEndSeconds?: number;
    force?: boolean;
    profile?: AbortSignal;
  }): Promise<PreparedUpload> {
    const work = this.libraryWork;
    return work.run(async () => {
      input.profile?.throwIfAborted();
      const root = await work.boundary(this.getLibraryRoot);
      input.profile?.throwIfAborted();
      if (!root) throw new Error("Choose a Mago library folder first");
      const trim = normalizeSourceVideoTrim(input);
      const relativePath = uploadCachePath({ assetId: input.assetId, ...trim });
      const filePath = path.join(root, relativePath);
      return this.prepareInOrder(filePath, input.profile, async (signal) => {
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
          // Large videos may legitimately take over a minute. Teardown
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

  async prepareImage(
    input: CloudImageInput & { profile?: AbortSignal }
  ): Promise<CloudImageFile> {
    return this.libraryWork.run(() =>
      this.prepareInOrder(cloudImageCachePath(input), input.profile, (signal) =>
        prepareCloudImageFile(input, signal)
      )
    );
  }

  /** Serialize writers of one cache path without sharing force decisions or
   * keeping an unstarted task in either drain. */
  private async prepareInOrder<Result>(
    filePath: string,
    profile: AbortSignal | undefined,
    prepare: (signal: AbortSignal) => Promise<Result>
  ): Promise<Result> {
    profile?.throwIfAborted();
    const work = this.libraryWork;
    const { preparations } = work.state;
    const result = (preparations.get(filePath) ?? Promise.resolve()).then(
      async () => {
        const library = work.capture();
        const signal = profile ? AbortSignal.any([library, profile]) : library;
        signal.throwIfAborted();
        const issue = () => work.boundary(() => prepare(signal));
        const prepared = await (this.profileIo?.run(profile, issue) ?? issue());
        signal.throwIfAborted();
        return prepared;
      }
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
    profile?: AbortSignal;
  }): Promise<void> {
    return this.libraryWork.run(() => {
      const library = this.libraryWork.capture();
      const signal = input.profile
        ? AbortSignal.any([library, input.profile])
        : library;
      return this.transfer(
        signal,
        input.profile,
        input.onProgress,
        (onProgress) =>
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
      profile?: AbortSignal;
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
      const signal = AbortSignal.any([
        work.signal,
        entry.controller.signal,
        ...(input.profile ? [input.profile] : [])
      ]);
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
        entry.transfer = this.transfer(
          signal,
          input.profile,
          input.onProgress,
          (onProgress) =>
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
    profile: AbortSignal | undefined,
    listener: Progress | undefined,
    issue: (progress: Progress) => Promise<void>
  ): Promise<void> {
    let active = true;
    try {
      signal.throwIfAborted();
      const transfer = () =>
        this.libraryWork.boundary(() =>
          issue((fraction) => {
            if (active && !signal.aborted) listener?.(fraction);
          })
        );
      await (this.profileIo
        ? this.profileIo.run(profile, transfer)
        : transfer());
      signal.throwIfAborted();
    } finally {
      active = false;
    }
  }
}
