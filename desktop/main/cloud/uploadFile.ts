import type { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import https, { Agent } from "node:https";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Main-process streaming keeps native paths out of the renderer and avoids
 * holding a large video in memory. The renderer supplies its presigned URL. */
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;
const ERROR_BODY_LIMIT = 500;

export interface PresignedUploadRequest {
  filePath: string;
  presignedUrl: string;
  contentType: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Test seam: lets an integration test trust a local self-signed listener. */
  agent?: Agent;
  assertAccess?: () => Promise<void>;
}

export const assertUploadUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The upload URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Refusing to upload over anything but https");
  }
  return url;
};

export const uploadHeaders = (
  contentType: string,
  sizeBytes: number
): Record<string, string | number> => ({
  // The presigned PUT requires a declared length, not chunked encoding.
  "content-type": contentType,
  "content-length": sizeBytes
});

const cancellationError = () => new Error("The upload was cancelled");
const checkCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw cancellationError();
};

export const uploadFileToPresignedUrl = async (
  request: PresignedUploadRequest
): Promise<void> => {
  checkCancelled(request.signal);
  const url = assertUploadUrl(request.presignedUrl);
  const { size } = await stat(request.filePath);
  checkCancelled(request.signal);
  if (size === 0) throw new Error("Refusing to upload an empty file");
  await request.assertAccess?.();
  checkCancelled(request.signal);
  await putToPresignedUrl({
    ...request,
    url,
    size,
    source: createReadStream(request.filePath)
  });
};

/** PUTs bytes the renderer already holds, e.g. a video the user just trimmed. */
export const uploadBytesToPresignedUrl = async (request: {
  bytes: Buffer;
  presignedUrl: string;
  contentType: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  agent?: Agent;
  assertAccess?: () => Promise<void>;
}): Promise<void> => {
  checkCancelled(request.signal);
  const url = assertUploadUrl(request.presignedUrl);
  if (request.bytes.length === 0) {
    throw new Error("Refusing to upload an empty file");
  }
  await request.assertAccess?.();
  checkCancelled(request.signal);
  await putToPresignedUrl({
    ...request,
    url,
    size: request.bytes.length,
    source: Readable.from([request.bytes])
  });
};

const waitForClose = (stream: EventEmitter): Promise<void> =>
  new Promise((resolve) => stream.once("close", resolve));

/** A response header, a stream error and destroy() do not release a file or
 * a body. Wait through close on both success and cancellation. */
const putToPresignedUrl = async ({
  url,
  size,
  source,
  contentType,
  onProgress,
  signal,
  agent
}: {
  url: URL;
  size: number;
  source: Readable;
  contentType: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  agent?: Agent;
}): Promise<void> => {
  let stopped = false;
  let uploaded = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      uploaded += chunk.length;
      try {
        if (!stopped && !signal?.aborted) onProgress?.(uploaded / size);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      callback(null, chunk);
    }
  });
  const sourceClosed = waitForClose(source);
  const counterClosed = waitForClose(counter);
  let outbound: ClientRequest | undefined;
  let outboundClosed: Promise<void> | undefined;
  let response: IncomingMessage | undefined;
  let responseClosed: Promise<void> | undefined;
  let rejectResponse!: (error: unknown) => void;
  const responseDone = new Promise<void>((resolve, reject) => {
    rejectResponse = reject;
    // Also observe stream errors if request construction throws before pipeline.
    source.on("error", reject);
    checkCancelled(signal);
    outbound = https.request(
      url,
      { method: "PUT", headers: uploadHeaders(contentType, size), agent },
      (incoming) => {
        response = incoming;
        responseClosed = waitForClose(incoming);
        const status = incoming.statusCode ?? 0;
        const ok = status >= HTTP_OK_MIN && status < HTTP_OK_MAX;
        let ended = false;
        let body = "";
        if (!ok) {
          incoming.on("data", (chunk: Buffer) => {
            body = `${body}${chunk.toString()}`.slice(0, ERROR_BODY_LIMIT);
          });
        }
        incoming.on("error", reject);
        incoming.once("end", () => {
          ended = true;
          if (ok) resolve();
          else
            reject(
              new Error(
                `The upload was rejected with status ${status}${body.trim() ? `: ${body.trim()}` : ""}`
              )
            );
        });
        incoming.once("close", () => {
          if (!ended)
            reject(new Error("The upload response closed before completion"));
        });
        if (stopped || signal?.aborted) incoming.destroy();
        else incoming.resume();
      }
    );
    outboundClosed = waitForClose(outbound);
    outbound.on("error", reject);
    outbound.once("close", () => {
      if (!response) reject(new Error("The upload closed before a response"));
    });
  });
  const stop = () => {
    stopped = true;
    source.destroy();
    counter.destroy();
    response?.destroy();
    outbound?.destroy();
  };
  const abort = () => {
    rejectResponse(cancellationError());
    stop();
  };
  let sending: Promise<void> | undefined;
  let completed = false;
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    if (!stopped && outbound) sending = pipeline(source, counter, outbound);
    await Promise.all([responseDone, sending]);
    completed = true;
  } finally {
    if (!completed) stop();
    await Promise.allSettled([
      sourceClosed,
      counterClosed,
      outboundClosed,
      sending
    ]);
    // Node can deliver a response during abort/cleanup, but not after the
    // request closes. Read this promise after draining the request itself.
    await responseClosed;
    signal?.removeEventListener("abort", abort);
  }
  checkCancelled(signal);
};
