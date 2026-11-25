import { z } from "zod";

import { readProviderJson } from "./providerResponseBody";

const queueOrigin = "https://queue.fal.run";
const endpointPattern =
  /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)+$/;
const requestIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const requestTimeoutMs = 30_000;
const badRequest = 400;
const notFound = 404;
const cancelAcknowledgementStatuses = [badRequest, notFound] as const;

const queueStateSchema = z.object({
  request_id: requestIdSchema,
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
  error: z.string().nullish(),
  error_type: z.string().nullish()
});

const cancelSchema = z.object({
  status: z.enum([
    "OK",
    "CANCELLATION_REQUESTED",
    "ALREADY_COMPLETED",
    "NOT_FOUND"
  ])
});

export class FalQueueHttpError extends Error {
  constructor(readonly status: number) {
    super(`fal queue returned HTTP ${status}`);
  }
}

export const assertFalEndpoint = (endpoint: string): void => {
  if (!endpointPattern.test(endpoint))
    throw new Error("Invalid fal endpoint ID");
};

const requestUrls = (endpoint: string, requestId: string) => {
  assertFalEndpoint(endpoint);
  if (!requestIdSchema.safeParse(requestId).success)
    throw new Error("Invalid fal request ID");
  const app = endpoint.split("/").slice(0, 2).join("/");
  const resultUrl = `${queueOrigin}/${app}/requests/${requestId}`;
  return {
    resultUrl,
    statusUrl: `${resultUrl}/status`,
    cancelUrl: `${resultUrl}/cancel`
  };
};

export class FalQueueClient {
  constructor(private readonly key: string) {}

  async submit(
    endpoint: string,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    assertFalEndpoint(endpoint);
    const response = queueStateSchema.safeParse(
      await this.request(
        `${queueOrigin}/${endpoint}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-app-fal-disable-fallback": "true"
          },
          body: JSON.stringify(input)
        },
        signal
      )
    );
    if (!response.success)
      throw new Error("Invalid fal queue submission response");
    // Follow-up URLs come from the documented app path and request ID.
    // Provider-supplied links never determine where the key is sent.
    return response.data.request_id;
  }

  async status(endpoint: string, requestId: string, signal?: AbortSignal) {
    const url = requestUrls(endpoint, requestId).statusUrl;
    const response = queueStateSchema.safeParse(
      await this.request(url, { method: "GET" }, signal)
    );
    if (!response.success || response.data.request_id !== requestId)
      throw new Error("Invalid fal queue status response");
    return response.data;
  }

  result(
    endpoint: string,
    requestId: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.request(
      requestUrls(endpoint, requestId).resultUrl,
      { method: "GET" },
      signal
    );
  }

  async cancel(endpoint: string, requestId: string, signal?: AbortSignal) {
    const url = requestUrls(endpoint, requestId).cancelUrl;
    const response = cancelSchema.safeParse(
      await this.request(
        url,
        { method: "PUT" },
        signal,
        cancelAcknowledgementStatuses
      )
    );
    if (!response.success)
      throw new Error("Invalid fal queue cancellation response");
    return response.data.status;
  }

  private async request(
    url: string,
    options: {
      method: "GET" | "POST" | "PUT";
      headers?: Record<string, string>;
      body?: string;
    },
    callerSignal?: AbortSignal,
    acceptedErrors: readonly number[] = []
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        signal,
        redirect: "error",
        headers: {
          ...options.headers,
          Authorization: `Key ${this.key}`
        }
      });
    } catch {
      if (callerSignal?.aborted) throw new Error("fal queue request cancelled");
      if (timeout.aborted) throw new Error("fal queue request timed out");
      throw new Error("Could not reach fal queue");
    }
    if (signal.aborted) {
      await response.body?.cancel(signal.reason).catch(() => {});
      signal.throwIfAborted();
    }
    if (!response.ok && !acceptedErrors.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new FalQueueHttpError(response.status);
    }
    try {
      return await readProviderJson(response, signal);
    } catch {
      if (callerSignal?.aborted) throw new Error("fal queue request cancelled");
      if (timeout.aborted) throw new Error("fal queue request timed out");
      throw new Error("fal queue returned invalid JSON");
    }
  }
}
