import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";

import {
  formatComfyError,
  formatComfyHttpError
} from "../imageRenders/comfyError";
import { atomicProduceFile } from "../storage/atomicFile";

import { asRecord } from "./asRecord";
import { COMFY_PROCESS_CLIENT_ID } from "./comfyClientId";
import type { ComfyFileReference } from "./comfyFileReference";
import type { ComfyGraph } from "./comfyGraph";
import { comfyMimeTypeForFile } from "./comfyMimeTypeForFile";
import type { ComfyProgressMonitor } from "./ComfyProgressMonitor";
import { comfyProgressMonitorFor } from "./comfyProgressMonitors";
import { normalizeComfyEndpoint } from "./normalizeComfyEndpoint";
import { promptQueueContains } from "./promptQueueContains";
import {
  awaitComfyAbort,
  readComfyPromptWithSafetyPoll
} from "./readComfyPromptWithSafetyPoll";

const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const UPLOAD_SUBFOLDER = "mago";
const CONTENT_HASH_NAME_LENGTH = 32;

export const COMFY_LOST_PROMPT_MESSAGE =
  "ComfyUI no longer has this render. ComfyUI may have restarted; start the render again.";

export type ComfyPromptStatus =
  | { state: "queued" | "running" }
  | { state: "finished"; outputs: Record<string, unknown> }
  | { state: "error"; message: string };

export type ComfyPromptWaitResult =
  | { kind: "finished"; outputs: Record<string, unknown> }
  | { kind: "cancelled" }
  | { kind: "timedOut" };

type ComfyPromptMonitor = Pick<
  ComfyProgressMonitor,
  "watch" | "forget" | "livePrompt" | "waitForSettle" | "resetConnection"
> &
  Partial<Pick<ComfyProgressMonitor, "clientId">>;

const profileTransfers = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

export const drainComfyProfile = async (
  profile: AbortSignal
): Promise<void> => {
  const transfers = profileTransfers.get(profile);
  if (transfers) await Promise.allSettled(transfers);
};

const hashFile = async (
  filePath: string,
  signal?: AbortSignal
): Promise<string> => {
  const stream = createReadStream(filePath, { signal });
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  try {
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    stream.destroy();
    await closed;
  }
};

const cancelBody = (response: Response) =>
  response.body?.cancel().catch(() => {});

// Fetch abort normally stops consumption, but explicitly cancel a locked body
// too so injected transports cannot leave an active reader behind.
const readText = async (
  response: Response,
  signal?: AbortSignal
): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let cleanup: Promise<unknown> | undefined;
  const cancel = () => {
    cleanup ??= reader.cancel().catch(() => {});
  };
  const abort = signal && addAbortListener(signal, cancel);
  try {
    signal?.throwIfAborted();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    abort?.[Symbol.dispose]();
    await cleanup;
    reader.releaseLock();
  }
};

export class ComfyClient {
  readonly endpoint: string;
  private readonly monitor: ComfyPromptMonitor;
  private readonly signal?: AbortSignal;

  constructor(
    endpoint: string,
    monitor?: ComfyPromptMonitor,
    signal?: AbortSignal,
    private readonly profile?: AbortSignal,
    private readonly beforeSubmit?: () => Promise<void>
  ) {
    this.endpoint = normalizeComfyEndpoint(endpoint);
    this.signal =
      profile && signal
        ? AbortSignal.any([profile, signal])
        : (profile ?? signal);
    this.monitor = monitor ?? comfyProgressMonitorFor(this.endpoint, profile);
  }

  async checkAvailable(): Promise<void> {
    await this.getJson("/system_stats");
  }

  async getJson(pathname: string): Promise<Record<string, unknown>> {
    return (await this.getPayload(pathname)) as Record<string, unknown>;
  }

  async getPayload(pathname: string, signal?: AbortSignal): Promise<unknown> {
    return this.json(pathname, { method: "GET", signal });
  }

  async submitGraph(graph: ComfyGraph): Promise<string> {
    this.signal?.throwIfAborted();
    if (this.beforeSubmit) await this.beforeSubmit();
    const response = (await this.json("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: graph,
        client_id: this.monitor.clientId ?? COMFY_PROCESS_CLIENT_ID
      })
    })) as Record<string, unknown>;
    this.signal?.throwIfAborted();
    if (typeof response.prompt_id !== "string" || !response.prompt_id)
      throw new Error(formatComfyError(response));
    this.monitor.watch(response.prompt_id, graph);
    return response.prompt_id;
  }

  async uploadFile(filePath: string): Promise<string> {
    return this.transfer(async () => {
      const extension = path.extname(filePath).toLowerCase() || ".png";
      const contentHash = await hashFile(filePath, this.signal);
      this.signal?.throwIfAborted();
      const filename = `${contentHash.slice(0, CONTENT_HASH_NAME_LENGTH)}${extension}`;
      const stream = createReadStream(filePath, { signal: this.signal });
      const sourceClosed = new Promise<void>((resolve) =>
        stream.once("close", resolve)
      );
      // Observe fs errors even when fetch never starts pulling the multipart.
      stream.on("error", () => {});
      try {
        return await this.uploadMultipart(
          filename,
          comfyMimeTypeForFile(filePath),
          stream,
          () => stream.destroy()
        );
      } finally {
        stream.destroy();
        await sourceClosed;
      }
    });
  }

  async uploadBytes(
    bytes: Buffer,
    mime: string,
    extension: string
  ): Promise<string> {
    return this.transfer(() => {
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const filename = `${contentHash.slice(0, CONTENT_HASH_NAME_LENGTH)}${extension}`;
      return this.uploadMultipart(filename, mime, [Buffer.from(bytes)]);
    });
  }

  private async uploadMultipart(
    filename: string,
    mime: string,
    chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
    stopSource?: () => void
  ): Promise<string> {
    const boundary = `mago-${randomUUID()}`;
    const multipart = Readable.from(
      (async function* () {
        yield Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${encodeURIComponent(filename)}"\r\nContent-Type: ${mime}\r\n\r\n`
        );
        yield* chunks;
        for (const [name, value] of [
          ["type", "input"],
          ["subfolder", UPLOAD_SUBFOLDER],
          ["overwrite", "true"]
        ])
          yield Buffer.from(
            `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`
          );
        yield Buffer.from(`\r\n--${boundary}--\r\n`);
      })(),
      { objectMode: false }
    );
    const multipartClosed = finished(multipart, { cleanup: true }).catch(
      () => {}
    );
    const stopUpload = () => {
      stopSource?.();
      multipart.destroy();
    };
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = this.requestSignal(timeout);
    const abort = addAbortListener(signal, stopUpload);
    try {
      const init = {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`
        },
        body: Readable.toWeb(multipart, {
          strategy: {
            highWaterMark: multipart.readableHighWaterMark,
            size: (chunk: Buffer) => chunk.byteLength
          }
        }) as unknown as ReadableStream<Uint8Array>,
        duplex: "half",
        signal: timeout
      };
      return await this.upload(init, filename);
    } finally {
      abort[Symbol.dispose]();
      stopUpload();
      await multipartClosed;
    }
  }

  async readPromptStatus(promptId: string): Promise<ComfyPromptStatus> {
    const status = await this.readPromptStatusOverHttp(promptId);
    this.signal?.throwIfAborted();
    const isPromptOver =
      status.state === "finished" || status.state === "error";
    if (isPromptOver) this.monitor.forget(promptId);
    return status;
  }

  private async readPromptStatusOverHttp(
    promptId: string
  ): Promise<ComfyPromptStatus> {
    const historyEntry = await this.readHistoryEntry(promptId);
    if (historyEntry) return this.statusFromHistory(historyEntry);
    const queue = await this.getJson("/queue");
    if (promptQueueContains(queue.queue_running, promptId))
      return { state: "running" };
    if (promptQueueContains(queue.queue_pending, promptId))
      return { state: "queued" };
    const lateHistoryEntry = await this.readHistoryEntry(promptId);
    if (lateHistoryEntry) return this.statusFromHistory(lateHistoryEntry);
    return { state: "error", message: COMFY_LOST_PROMPT_MESSAGE };
  }

  async downloadBuffer(
    reference: ComfyFileReference,
    { maxBytes, defaultType }: { maxBytes: number; defaultType: string }
  ): Promise<Buffer> {
    return this.transfer(async () => {
      const signal = this.requestSignal(
        AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      );
      const response = await this.requestView(reference, defaultType, signal);
      const declaredLength = Number(
        response.headers.get("content-length") ?? 0
      );
      if (declaredLength > maxBytes) {
        await cancelBody(response);
        throw new Error("ComfyUI output is too large");
      }
      if (!response.body) throw new Error("ComfyUI returned an invalid output");
      const chunks: Buffer[] = [];
      let received = 0;
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > maxBytes)
              callback(new Error("ComfyUI output is too large"));
            else {
              chunks.push(chunk);
              callback();
            }
          }
        }),
        { signal }
      );
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks);
      if (!bytes.length || bytes.length > maxBytes)
        throw new Error("ComfyUI returned an invalid output");
      return bytes;
    });
  }

  async downloadToFile(
    reference: ComfyFileReference,
    destinationPath: string,
    { maxBytes, defaultType }: { maxBytes: number; defaultType: string }
  ): Promise<void> {
    return this.transfer(async () => {
      const signal = this.requestSignal(
        AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      );
      const response = await this.requestView(reference, defaultType, signal);
      const declaredLength = Number(
        response.headers.get("content-length") ?? 0
      );
      if (declaredLength > maxBytes) {
        await cancelBody(response);
        throw new Error("ComfyUI output is too large");
      }
      if (!response.body) throw new Error("ComfyUI returned an invalid output");
      let receivedBytes = 0;
      const enforceSizeLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBytes)
            callback(new Error("ComfyUI output is too large"));
          else callback(null, chunk);
        }
      });
      // The publication check runs after fsync and any queued rename.
      try {
        await atomicProduceFile(
          destinationPath,
          async (temporary) => {
            await pipeline(
              Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
              enforceSizeLimit,
              createWriteStream(temporary),
              { signal }
            );
            signal.throwIfAborted();
            if (receivedBytes === 0)
              throw new Error("ComfyUI returned an invalid output");
          },
          signal
        );
      } finally {
        // If retirement prevented the producer from starting, the body was never locked.
        if (!response.bodyUsed && !response.body.locked)
          await cancelBody(response);
      }
    });
  }

  async cancel(promptId: string): Promise<void> {
    const queue = await this.getJson("/queue");
    if (promptQueueContains(queue.queue_pending, promptId)) {
      await this.deleteFromQueue(promptId);
    } else if (promptQueueContains(queue.queue_running, promptId)) {
      await this.json("/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: promptId })
      });
    }
    this.signal?.throwIfAborted();
    this.monitor.forget(promptId);
  }

  async removeFromQueueIfPending(promptId: string): Promise<void> {
    const queue = await this.getJson("/queue");
    if (promptQueueContains(queue.queue_pending, promptId))
      await this.deleteFromQueue(promptId);
    this.signal?.throwIfAborted();
    this.monitor.forget(promptId);
  }

  forgetPrompt(promptId: string): void {
    this.monitor.forget(promptId);
  }

  async waitForPrompt(
    promptId: string,
    {
      timeoutMs,
      pollIntervalMs,
      isCancelled
    }: {
      timeoutMs: number;
      pollIntervalMs: number;
      isCancelled?: () => boolean;
    }
  ): Promise<ComfyPromptWaitResult> {
    const deadline = Date.now() + timeoutMs;
    let lastStatusCheckAt = Number.NEGATIVE_INFINITY;
    for (;;) {
      this.signal?.throwIfAborted();
      if (isCancelled?.()) return { kind: "cancelled" };
      const { result, statusCheckedAt } = await readComfyPromptWithSafetyPoll({
        monitor: this.monitor,
        promptId,
        lastStatusCheckAt,
        readOverHttp: () => this.readPromptStatus(promptId),
        signal: this.signal
      });
      lastStatusCheckAt = statusCheckedAt ?? lastStatusCheckAt;
      if (result.state === "error") throw new Error(result.message);
      if (result.state === "finished")
        return { kind: "finished", outputs: result.outputs };
      if (Date.now() > deadline) return { kind: "timedOut" };
      try {
        if (this.monitor.livePrompt(promptId))
          await this.monitor.waitForSettle(
            promptId,
            pollIntervalMs,
            this.signal
          );
        else await sleep(pollIntervalMs, undefined, { signal: this.signal });
      } catch (error) {
        this.signal?.throwIfAborted();
        throw error;
      }
    }
  }

  private statusFromHistory(entry: Record<string, unknown>): ComfyPromptStatus {
    const status = asRecord(entry.status);
    if (status?.status_str === "error")
      return {
        state: "error",
        message: formatComfyError(status.messages ?? status)
      };
    const outputs = asRecord(entry.outputs) ?? {};
    const hasOutputs = Object.keys(outputs).length > 0;
    const isComplete =
      status?.completed === true ||
      status?.status_str === "success" ||
      (!status && hasOutputs);
    return isComplete ? { state: "finished", outputs } : { state: "running" };
  }

  private async readHistoryEntry(
    promptId: string
  ): Promise<Record<string, unknown> | null> {
    const history = await this.getJson(
      `/history/${encodeURIComponent(promptId)}`
    );
    return asRecord(history[promptId]);
  }

  private async upload(init: RequestInit, filename: string): Promise<string> {
    const response = (await this.json("/upload/image", init, true)) as Record<
      string,
      unknown
    >;
    const name = typeof response.name === "string" ? response.name : filename;
    const subfolder =
      typeof response.subfolder === "string"
        ? response.subfolder
        : UPLOAD_SUBFOLDER;
    return subfolder ? `${subfolder}/${name}` : name;
  }

  private async deleteFromQueue(promptId: string): Promise<void> {
    await this.json("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] })
    });
  }

  private requestView(
    reference: ComfyFileReference,
    defaultType: string,
    signal: AbortSignal
  ): Promise<Response> {
    const query = new URLSearchParams({
      filename: reference.filename,
      subfolder: reference.subfolder ?? "",
      type: reference.type ?? defaultType
    });
    return this.requestWithSignal(
      `/view?${query}`,
      { method: "GET" },
      signal,
      true
    );
  }

  private async transfer<T>(operation: () => Promise<T>): Promise<T> {
    this.signal?.throwIfAborted();
    if (!this.profile) return operation();
    let transfers = profileTransfers.get(this.profile);
    if (!transfers) profileTransfers.set(this.profile, (transfers = new Set()));
    const issued = Promise.resolve().then(() => {
      this.signal?.throwIfAborted();
      return operation();
    });
    transfers.add(issued);
    try {
      const result = await issued;
      this.signal?.throwIfAborted();
      return result;
    } catch (error) {
      this.signal?.throwIfAborted();
      throw error;
    } finally {
      transfers.delete(issued);
    }
  }

  private requestSignal(
    signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  ): AbortSignal {
    return this.signal ? AbortSignal.any([this.signal, signal]) : signal;
  }

  private async json(
    pathname: string,
    init: RequestInit,
    drain = false
  ): Promise<unknown> {
    const signal = this.requestSignal(init.signal ?? undefined);
    const response = await this.requestWithSignal(
      pathname,
      init,
      signal,
      drain
    );
    try {
      const body = readText(response, signal);
      const text = drain ? await body : await awaitComfyAbort(body, signal);
      signal.throwIfAborted();
      return JSON.parse(text) as unknown;
    } catch {
      signal.throwIfAborted();
      throw new Error(`ComfyUI returned invalid JSON for ${pathname}`);
    }
  }

  async request(pathname: string, init: RequestInit): Promise<Response> {
    return this.requestWithSignal(
      pathname,
      init,
      this.requestSignal(init.signal ?? undefined),
      false
    );
  }

  private async requestWithSignal(
    pathname: string,
    init: RequestInit,
    signal: AbortSignal,
    drain: boolean
  ): Promise<Response> {
    signal.throwIfAborted();
    let unusedResponse: Response | undefined;
    const issued = async () => {
      let response: Response;
      try {
        response = await fetch(`${this.endpoint}${pathname}`, {
          ...init,
          signal
        });
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(
          `Cannot reach ComfyUI at ${this.endpoint}: ${error instanceof Error ? error.message : "network error"}`
        );
      }
      if (signal.aborted) {
        await cancelBody(response);
        signal.throwIfAborted();
      }
      if (!response.ok) {
        const body = await readText(response, signal);
        signal.throwIfAborted();
        throw new Error(
          formatComfyHttpError(response.status, response.statusText, body)
        );
      }
      unusedResponse = response;
      return response;
    };
    if (drain) return issued();
    try {
      return await awaitComfyAbort(issued(), signal);
    } catch (error) {
      if (unusedResponse) void cancelBody(unusedResponse);
      throw error;
    }
  }
}

export const createProfileComfyClient = (
  endpoint: string,
  profile: AbortSignal,
  signal?: AbortSignal
): ComfyClient => new ComfyClient(endpoint, undefined, signal, profile);
