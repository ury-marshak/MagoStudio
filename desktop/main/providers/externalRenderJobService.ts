import { LibraryWorkSession } from "../libraryWorkSession";

import {
  type ExternalRenderAssets,
  RenderOutputUnavailable
} from "./externalRenderAssets";
import type {
  ExternalRenderJob,
  ExternalRenderJobRepository
} from "./externalRenderJobRepository";
import {
  type MediaRenderProvider,
  type MediaRenderRequest,
  RenderSubmissionRejected
} from "./mediaRenderProvider";

type Submission = Pick<
  ExternalRenderJob,
  | "id"
  | "projectId"
  | "provider"
  | "endpoint"
  | "kind"
  | "requestJson"
  | "inputAssetIds"
> & {
  /** Legacy image-only mapping, retained for existing callers. */
  assetUrlField?: string;
  /** Ordered modality groups; their flattened IDs must match inputAssetIds. */
  assetInputs?: Array<{
    field: string;
    kind: "image" | "video";
    assetIds: string[];
  }>;
};

const remoteRequest = (
  job: ExternalRenderJob,
  requestId: string
): MediaRenderRequest => ({
  endpoint: job.endpoint,
  requestId,
  keychainAccount: job.keychainAccount
});

export class ExternalRenderJobService {
  private readonly work = new LibraryWorkSession(() => ({
    ingestions: new Map<string, Promise<ExternalRenderJob>>()
  }));
  private get ingestions() {
    return this.work.state.ingestions;
  }

  constructor(
    private readonly jobs: ExternalRenderJobRepository,
    private readonly providers: ReadonlyMap<string, MediaRenderProvider>,
    private readonly assets: ExternalRenderAssets
  ) {
    this.jobs = this.work.guard(jobs);
    this.assets = this.work.guard(assets);
    this.get = this.work.bind(this.get.bind(this));
    this.submit = this.work.bind(this.submit.bind(this));
    this.refresh = this.work.bind(this.refresh.bind(this));
    this.ingest = this.work.bind(this.ingest.bind(this));
    this.cancel = this.work.bind(this.cancel.bind(this));
  }

  /** Abort local transport/ingestion only, never issue provider cancellation. */
  stop(): void {
    this.work.stop();
  }
  suspend(): Promise<void> {
    return this.work.suspend();
  }
  reset(): void {
    this.work.reset();
  }
  captureSession(): AbortSignal {
    return this.work.capture();
  }

  get(id: string): Promise<ExternalRenderJob | null> {
    return this.jobs.get(id);
  }

  async submit(
    input: Submission,
    signal?: AbortSignal
  ): Promise<ExternalRenderJob> {
    signal = signal
      ? AbortSignal.any([signal, this.work.capture()])
      : this.work.capture();
    const submission = structuredClone(input);
    signal?.throwIfAborted();
    const { assetUrlField, assetInputs, ...job } = submission;
    if (assetUrlField && assetInputs)
      throw new Error("Choose either legacy or typed render inputs");
    if (assetInputs && !assetInputs.length)
      throw new Error("Select at least one typed render input group");
    const groups =
      assetInputs ??
      (assetUrlField
        ? [
            {
              field: assetUrlField,
              kind: "image" as const,
              assetIds: job.inputAssetIds
            }
          ]
        : []);
    const fields = groups.map((group) => group.field);
    if (
      fields.some(
        (field) =>
          !/^[a-z][a-z0-9_]*$/.test(field) ||
          field === "constructor" ||
          field === "prototype"
      ) ||
      new Set(fields).size !== fields.length
    )
      throw new Error("Render input fields must be unique safe array fields");
    if (
      groups.length &&
      (groups.some((group) => !group.assetIds.length) ||
        JSON.stringify(groups.flatMap((group) => group.assetIds)) !==
          JSON.stringify(job.inputAssetIds))
    )
      throw new Error(
        "Render input groups must match the ordered input asset IDs"
      );
    const provider = this.providerFor(submission.provider);
    const prepared = await provider.prepareSubmission(submission.endpoint);
    signal.throwIfAborted();
    // Resolve every local input before starting any upload. Validation/upload
    // failures leave no uncertain paid generation job behind.
    const resolved = [];
    for (const group of groups) {
      const files = [];
      for (const id of group.assetIds) {
        signal?.throwIfAborted();
        files.push(await this.assets.input(job.projectId, id, group.kind));
      }
      resolved.push({ field: group.field, files });
    }
    if (resolved.length && !prepared.upload)
      throw new Error("This provider does not support input uploads");
    for (const group of resolved) {
      const urls: string[] = [];
      for (const { file, name } of group.files) {
        signal?.throwIfAborted();
        urls.push(await prepared.upload!(file, name, signal));
      }
      job.requestJson = { ...job.requestJson, [group.field]: urls };
    }
    signal?.throwIfAborted();
    await this.jobs.beginSubmission({
      ...job,
      keychainAccount: prepared.keychainAccount
    });
    let requestId: string;
    try {
      signal.throwIfAborted();
      requestId = await prepared.submit(job.requestJson, signal);
    } catch (error) {
      if (error instanceof RenderSubmissionRejected) {
        await this.jobs.settleSubmission(submission.id, {
          status: "FAILED",
          error: error.message
        });
        throw error;
      }
      const message = `${submission.provider} may have accepted this job. Check the provider's request history before submitting it again.`;
      await this.jobs.settleSubmission(submission.id, {
        status: "SUBMISSION_UNKNOWN",
        error: message
      });
      throw new Error(message, { cause: error });
    }
    await this.jobs.settleSubmission(submission.id, {
      status: "SUBMITTED",
      requestId
    });
    return this.requireJob(submission.id);
  }

  async refresh(id: string, signal?: AbortSignal): Promise<ExternalRenderJob> {
    signal = signal
      ? AbortSignal.any([signal, this.work.capture()])
      : this.work.capture();
    const job = await this.requireJob(id);
    if (
      !job.requestId ||
      (job.status !== "SUBMITTED" && job.status !== "CANCELLATION_REQUESTED")
    )
      return job;
    const result = await this.providerFor(job.provider).refresh(
      remoteRequest(job, job.requestId),
      job.kind,
      signal
    );
    signal.throwIfAborted();
    if (result.status !== "PENDING")
      await this.jobs.settleRemoteJob(id, result);
    return this.requireJob(id);
  }

  /** Materialize a finished job in the library. Safe to retry after a restart. */
  async ingest(id: string, signal?: AbortSignal): Promise<ExternalRenderJob> {
    signal = signal
      ? AbortSignal.any([signal, this.work.capture()])
      : this.work.capture();
    const existing = this.ingestions.get(id);
    if (existing) return existing;
    const operation = this.ingestOutput(id, signal);
    this.ingestions.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.ingestions.get(id) === operation) this.ingestions.delete(id);
    }
  }

  private async ingestOutput(
    id: string,
    signal?: AbortSignal
  ): Promise<ExternalRenderJob> {
    const job = await this.requireJob(id);
    if (job.status !== "OUTPUT_READY" || !job.outputJson || !job.requestId)
      return job;
    let output = job.outputJson;
    if (!output.urls.length)
      throw new Error("The provider returned no render outputs");
    let files: Awaited<ReturnType<ExternalRenderAssets["download"]>>;
    try {
      files = await this.assets.download(job, output, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof RenderOutputUnavailable)) throw error;
      const result = await this.providerFor(job.provider).refresh(
        remoteRequest(job, job.requestId),
        job.kind,
        signal
      );
      if (
        result.status !== "OUTPUT_READY" ||
        result.outputJson.urls.length !== output.urls.length
      )
        throw error;
      output = result.outputJson;
      files = await this.assets.download(job, output, signal);
    }
    signal?.throwIfAborted();
    await this.jobs.finishIngestion(job, output, files);
    return this.requireJob(id);
  }

  async cancel(id: string, signal?: AbortSignal): Promise<ExternalRenderJob> {
    signal = signal
      ? AbortSignal.any([signal, this.work.capture()])
      : this.work.capture();
    const job = await this.requireJob(id);
    if (job.status !== "SUBMITTED" || !job.requestId) return job;
    const status = await this.providerFor(job.provider).cancel(
      remoteRequest(job, job.requestId),
      signal
    );
    if (status === "CANCELLED") await this.jobs.settleRemoteJob(id, { status });
    if (status === "CANCELLATION_REQUESTED")
      await this.jobs.markCancellationRequested(id);
    return this.requireJob(id);
  }

  private providerFor(id: string): MediaRenderProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Render provider is unavailable: ${id}`);
    return provider;
  }

  private async requireJob(id: string): Promise<ExternalRenderJob> {
    const job = await this.jobs.get(id);
    if (!job) throw new Error("External render job not found");
    return job;
  }
}
