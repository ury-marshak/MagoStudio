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
  if (!initiated.ok) {
    await initiated.body?.cancel();
    throw new Error(`fal upload initiation returned HTTP ${initiated.status}`);
  }
  const parsed = uploadResponse.safeParse(await initiated.json());
  if (!parsed.success) throw new Error("fal returned invalid upload URLs");
  const uploaded = await fetch(parsed.data.upload_url, {
    method: "PUT",
    redirect: "error",
    signal,
    headers: { "Content-Type": contentType },
    body: file
  });
  await uploaded.body?.cancel();
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
    private readonly getConfig: () => Promise<FalProviderConfig | null>,
    private readonly readKey = readExternalProviderKey
  ) {}

  async prepareSubmission(endpoint: string) {
    assertFalEndpoint(endpoint);
    const config = await this.getConfig();
    if (!config) throw new Error("Configure the fal Keychain account first");
    const key = await this.readKey(config.keychainAccount);
    const client = new FalQueueClient(key);
    return {
      keychainAccount: config.keychainAccount,
      upload: (file: Blob, name: string, signal?: AbortSignal) =>
        uploadToFal(key, file, name, signal),
      submit: async (input: Record<string, unknown>, signal?: AbortSignal) => {
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

  async refresh(
    { endpoint, requestId, keychainAccount }: MediaRenderRequest,
    kind: MediaRenderKind,
    signal?: AbortSignal
  ): Promise<MediaRenderState> {
    const client = await this.client(keychainAccount);
    const status = await client.status(endpoint, requestId, signal);
    if (status.status !== "COMPLETED") return { status: "PENDING" };

    let output: unknown;
    try {
      output = await client.result(endpoint, requestId, signal);
    } catch (error) {
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
    if (status.error || status.error_type)
      return { status: "FAILED", error: "fal reported that the render failed" };
    return { status: "OUTPUT_READY", outputJson: outputFrom(kind, output) };
  }

  async cancel(
    { endpoint, requestId, keychainAccount }: MediaRenderRequest,
    signal?: AbortSignal
  ) {
    const client = await this.client(keychainAccount);
    const result = await client.cancel(endpoint, requestId, signal);
    if (result === "OK") return "CANCELLED";
    if (result === "CANCELLATION_REQUESTED") return result;
    if (result === "NOT_FOUND")
      throw new Error("fal could not find the render to cancel");
    return "UNCHANGED";
  }

  private async client(keychainAccount: string): Promise<FalQueueClient> {
    return new FalQueueClient(await this.readKey(keychainAccount));
  }
}
