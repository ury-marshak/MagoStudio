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
>;

const remoteRequest = (
  job: ExternalRenderJob,
  requestId: string
): MediaRenderRequest => ({
  endpoint: job.endpoint,
  requestId,
  keychainAccount: job.keychainAccount
});

export class ExternalRenderJobService {
  constructor(
    private readonly jobs: ExternalRenderJobRepository,
    private readonly providers: ReadonlyMap<string, MediaRenderProvider>
  ) {}

  async submit(
    input: Submission,
    signal?: AbortSignal
  ): Promise<ExternalRenderJob> {
    const submission = structuredClone(input);
    signal?.throwIfAborted();
    const provider = this.providerFor(submission.provider);
    const prepared = await provider.prepareSubmission(submission.endpoint);
    signal?.throwIfAborted();
    await this.jobs.beginSubmission({
      ...submission,
      keychainAccount: prepared.keychainAccount
    });
    let requestId: string;
    try {
      requestId = await prepared.submit(submission.requestJson, signal);
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
