export type MediaRenderKind = "image" | "video";

export interface MediaRenderOutput {
  urls: string[];
  assetIds?: string[];
  seed?: number;
  referenceTokens?: number;
}

export interface MediaRenderRequest {
  endpoint: string;
  requestId: string;
  keychainAccount: string;
}

export type MediaRenderState =
  | { status: "PENDING" }
  | { status: "OUTPUT_READY"; outputJson: MediaRenderOutput }
  | { status: "FAILED"; error: string }
  | { status: "CANCELLED" };

export class RenderSubmissionRejected extends Error {}

/** The adapter owns remote requests. The job service owns local state. */
export interface MediaRenderProvider {
  prepareSubmission(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<{
    keychainAccount: string;
    upload?(file: Blob, name: string, signal?: AbortSignal): Promise<string>;
    submit(
      input: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<string>;
  }>;
  /** Optional local authorization for a saved output URL; must not contact the provider. */
  assertOutputAccess?(
    request: MediaRenderRequest,
    signal: AbortSignal
  ): Promise<void>;
  refresh(
    request: MediaRenderRequest,
    kind: MediaRenderKind,
    signal?: AbortSignal
  ): Promise<MediaRenderState>;
  cancel(
    request: MediaRenderRequest,
    signal?: AbortSignal
  ): Promise<"CANCELLED" | "CANCELLATION_REQUESTED" | "UNCHANGED">;
}
