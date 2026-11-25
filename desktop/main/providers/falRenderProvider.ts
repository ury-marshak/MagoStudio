import { z } from "zod";

import type { FalProviderConfig } from "../../shared/contracts";

import { readExternalProviderKey } from "./externalProviderSettings";
import {
  assertFalEndpoint,
  FalQueueClient,
  FalQueueHttpError
} from "./falQueue";
import {
  type MediaRenderKind,
  type MediaRenderOutput,
  type MediaRenderProvider,
  type MediaRenderRequest,
  type MediaRenderState,
  RenderSubmissionRejected
} from "./mediaRenderProvider";
import { readProviderJson } from "./providerResponseBody";
import { waitForInference } from "./sharedInference";

const badRequest = 400;
const unauthorized = 401;
const paymentRequired = 402;
const forbidden = 403;
const notFound = 404;
const invalidRenderInput = 422;
const rateLimited = 429;
const renderCancelled = 499;
const serverError = 500;
const rejectedSubmitStatuses = new Set([
  badRequest,
  unauthorized,
  paymentRequired,
  forbidden,
  notFound,
  invalidRenderInput,
  rateLimited
]);
const remoteFile = z.object({
  url: z.url({ protocol: /^https$/ }).refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  })
});
const falMediaFile = remoteFile.refine(({ url }) => {
  const { hostname, port } = new URL(url);
  return !port && (hostname === "fal.media" || hostname.endsWith(".fal.media"));
});
const uploadResponse = z.object({
  file_url: remoteFile.shape.url,
  upload_url: remoteFile.shape.url
});
const storageInitiate =
  "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const uploadTimeoutMs = 120_000;

const cancelUploadBody = async (response: Response, signal: AbortSignal) => {
  try {
    await response.body?.cancel();
  } catch (error) {
    // Fetch may already have errored the stream when its signal was aborted.
    signal.throwIfAborted();
    throw error;
  }
};

const waitForLookup = <T>(
  lookup: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  if (!signal) return lookup();
  signal.throwIfAborted();
  // Install the abort wait before calling even a non-cooperative lookup.
  return waitForInference(
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return lookup();
    }),
    signal
  );
};

const combineSignals = (origin?: AbortSignal, caller?: AbortSignal) =>
  origin && caller && origin !== caller
    ? AbortSignal.any([origin, caller])
    : (origin ?? caller);

const uploadToFal = async (
  key: string,
  file: Blob,
  name: string,
  callerSignal?: AbortSignal
): Promise<string> => {
  const timeout = AbortSignal.timeout(uploadTimeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeout])
    : timeout;
  signal.throwIfAborted();
  const contentType = file.type || "application/octet-stream";
  const initiated = await fetch(storageInitiate, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file_name: name, content_type: contentType })
  });
  if (signal.aborted || !initiated.ok) {
    await cancelUploadBody(initiated, signal);
    signal.throwIfAborted();
    throw new Error(`fal upload initiation returned HTTP ${initiated.status}`);
  }
  const response = await readProviderJson(initiated, signal);
  signal.throwIfAborted();
  const parsed = uploadResponse.safeParse(response);
  if (!parsed.success) throw new Error("fal returned invalid upload URLs");
  const uploaded = await fetch(parsed.data.upload_url, {
    method: "PUT",
    redirect: "error",
    signal,
    headers: { "Content-Type": contentType },
    body: file
  });
  await cancelUploadBody(uploaded, signal);
  signal.throwIfAborted();
  if (!uploaded.ok)
    throw new Error(`fal upload returned HTTP ${uploaded.status}`);
  return parsed.data.file_url;
};

const imageResult = z.object({ images: z.array(falMediaFile).min(1) });
const videoResult = z.object({
  video: falMediaFile,
  seed: z.number().int().nullish(),
  reference_tokens: z.number().int().nonnegative().nullish()
});

const outputFrom = (
  kind: MediaRenderKind,
  result: unknown
): MediaRenderOutput => {
  if (kind === "image") {
    const image = imageResult.safeParse(result);
    if (!image.success)
      throw new Error("fal did not return a valid image result");
    return { urls: image.data.images.map((file) => file.url) };
  }
  const video = videoResult.safeParse(result);
  if (!video.success)
    throw new Error("fal did not return a valid video result");
  return {
    urls: [video.data.video.url],
    seed: video.data.seed ?? undefined,
    referenceTokens: video.data.reference_tokens ?? undefined
  };
};

export class FalRenderProvider implements MediaRenderProvider {
  constructor(
    private readonly getConfig: (
      signal?: AbortSignal
    ) => Promise<FalProviderConfig | null>,
    private readonly readKey = readExternalProviderKey
  ) {}

  async prepareSubmission(endpoint: string, origin?: AbortSignal) {
    assertFalEndpoint(endpoint);
    const config = await waitForLookup(() => this.getConfig(origin), origin);
    origin?.throwIfAborted();
    if (!config) throw new Error("Configure the fal Keychain account first");
    const key = await this.key(config.keychainAccount, origin);
    origin?.throwIfAborted();
    const client = new FalQueueClient(key);
    return {
      keychainAccount: config.keychainAccount,
      upload: (file: Blob, name: string, caller?: AbortSignal) =>
        uploadToFal(key, file, name, combineSignals(origin, caller)),
      submit: async (input: Record<string, unknown>, caller?: AbortSignal) => {
        const signal = combineSignals(origin, caller);
        signal?.throwIfAborted();
        try {
          return await client.submit(endpoint, input, signal);
        } catch (error) {
          if (
            error instanceof FalQueueHttpError &&
            rejectedSubmitStatuses.has(error.status)
          )
            throw new RenderSubmissionRejected(error.message, { cause: error });
          throw error;
        }
      }
    };
  }

  async assertOutputAccess(
    { keychainAccount }: MediaRenderRequest,
    signal?: AbortSignal
  ) {
    const configured = await waitForLookup(
      () => this.getConfig(signal),
      signal
    );
    signal?.throwIfAborted();
    if (!configured || configured.keychainAccount !== keychainAccount)
      throw new Error(
        "Restore the fal Keychain account used for this render in Settings → Providers, then resume the plan."
      );
  }

  async refresh(
    request: MediaRenderRequest,
    kind: MediaRenderKind,
    signal?: AbortSignal
  ): Promise<MediaRenderState> {
    const { endpoint, requestId, keychainAccount } = request;
    await this.assertOutputAccess(request, signal);
    const key = await this.key(keychainAccount, signal);
    signal?.throwIfAborted();
    const client = new FalQueueClient(key);
    const status = await client.status(endpoint, requestId, signal);
    signal?.throwIfAborted();
    if (status.status !== "COMPLETED") return { status: "PENDING" };

    let output: unknown;
    try {
      output = await client.result(endpoint, requestId, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof FalQueueHttpError)) throw error;
      if (error.status === renderCancelled) return { status: "CANCELLED" };
      if (
        error.status === notFound ||
        error.status === invalidRenderInput ||
        (error.status >= serverError && (status.error || status.error_type))
      )
        return { status: "FAILED", error: error.message };
      throw error;
    }
    signal?.throwIfAborted();
    if (status.error || status.error_type)
      return { status: "FAILED", error: "fal reported that the render failed" };
    return { status: "OUTPUT_READY", outputJson: outputFrom(kind, output) };
  }

  async cancel(request: MediaRenderRequest, signal?: AbortSignal) {
    const { endpoint, requestId, keychainAccount } = request;
    await this.assertOutputAccess(request, signal);
    const key = await this.key(keychainAccount, signal);
    signal?.throwIfAborted();
    const result = await new FalQueueClient(key).cancel(
      endpoint,
      requestId,
      signal
    );
    signal?.throwIfAborted();
    if (result === "OK") return "CANCELLED";
    if (result === "CANCELLATION_REQUESTED") return result;
    if (result === "NOT_FOUND")
      throw new Error("fal could not find the render to cancel");
    return "UNCHANGED";
  }

  private key(keychainAccount: string, signal?: AbortSignal): Promise<string> {
    return waitForLookup(() => this.readKey(keychainAccount, signal), signal);
  }
}
