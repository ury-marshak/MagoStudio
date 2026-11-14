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
  /** Endpoint-specific array field for the ordered local input images. */
  assetUrlField?: string;
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
  private readonly ingestions = new Map<string, Promise<ExternalRenderJob>>();

  constructor(
    private readonly jobs: ExternalRenderJobRepository,
    private readonly providers: ReadonlyMap<string, MediaRenderProvider>,
    private readonly assets: ExternalRenderAssets
  ) {}

  get(id: string): Promise<ExternalRenderJob | null> {
    return this.jobs.get(id);
  }

  async submit(
    input: Submission,
    signal?: AbortSignal
  ): Promise<ExternalRenderJob> {
    const submission = structuredClone(input);
    signal?.throwIfAborted();
    const provider = this.providerFor(submission.provider);
    const prepared = await provider.prepareSubmission(submission.endpoint);
    const { assetUrlField, ...job } = submission;
    if (assetUrlField) {
      if (!prepared.upload)
        throw new Error("This provider does not support input uploads");
      if (!job.inputAssetIds.length)
        throw new Error("Select at least one render input image");
      const urls: string[] = [];
      for (const assetId of job.inputAssetIds) {
        signal?.throwIfAborted();
        const { file, name } = await this.assets.input(job.projectId, assetId);
        urls.push(await prepared.upload(file, name, signal));
      }
      job.requestJson = { ...job.requestJson, [assetUrlField]: urls };
    }
    signal?.throwIfAborted();
    await this.jobs.beginSubmission({
      ...job,
      keychainAccount: prepared.keychainAccount
    });
    let requestId: string;
    try {
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
    if (result.status !== "PENDING")
      await this.jobs.settleRemoteJob(id, result);
    return this.requireJob(id);
  }

  /** Materialize a finished job in the library. Safe to retry after a restart. */
  async ingest(id: string, signal?: AbortSignal): Promise<ExternalRenderJob> {
    const existing = this.ingestions.get(id);
    if (existing) return existing;
    const operation = this.ingestOutput(id, signal);
    this.ingestions.set(id, operation);
    try {
      return await operation;
    } finally {
      this.ingestions.delete(id);
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
