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
import type { ProfileIoDrain } from "./profileIoDrain";
import { waitForInference } from "./sharedInference";

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
    scalar?: true;
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

export type PreparedRenderInput = {
  file: Blob;
  name: string;
  kind: "image" | "video";
};

export class ExternalRenderJobService {
  private readonly work = new LibraryWorkSession(() => ({
    ingestions: new Map<
      string,
      { signal: AbortSignal; operation: Promise<ExternalRenderJob> }
    >()
  }));
  private get ingestions() {
    return this.work.state.ingestions;
  }

  constructor(
    private readonly jobs: ExternalRenderJobRepository,
    private readonly providers: ReadonlyMap<string, MediaRenderProvider>,
    private readonly assets: ExternalRenderAssets,
    private readonly profileIo?: Pick<ProfileIoDrain, "run">
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

  private runIo<T>(signal: AbortSignal, operation: () => Promise<T>) {
    signal.throwIfAborted();
    return this.profileIo?.run(signal, operation) ?? operation();
  }

  get(id: string): Promise<ExternalRenderJob | null> {
    return this.jobs.get(id);
  }

  async submit(
    input: Submission,
    signal?: AbortSignal,
    preparedInputs?: ReadonlyMap<string, PreparedRenderInput>,
    releasePreparedInputs?: () => Promise<void>
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
              assetIds: job.inputAssetIds,
              scalar: undefined
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
      throw new Error("Render input fields must be unique safe fields");
    if (groups.some(({ scalar, assetIds }) => scalar && assetIds.length !== 1))
      throw new Error("Scalar render inputs require exactly one asset");
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
    const prepared = await provider.prepareSubmission(
      submission.endpoint,
      signal
    );
    signal.throwIfAborted();
    // Resolve every local input before starting any upload. Validation/upload
    // failures leave no uncertain paid generation job behind.
    const resolved = [];
    for (const group of groups) {
      const files = [];
      for (const id of group.assetIds) {
        signal?.throwIfAborted();
        const snapshot = preparedInputs?.get(id);
        if (snapshot) {
          if (snapshot.kind !== group.kind)
            throw new Error(
              `Render input ${group.kind} is unavailable in this project`
            );
          files.push(snapshot);
        } else {
          files.push(await this.assets.input(job.projectId, id, group.kind));
        }
      }
      resolved.push({ field: group.field, files, scalar: group.scalar });
    }
    if (resolved.length && !prepared.upload)
      throw new Error("This provider does not support input uploads");
    for (const group of resolved) {
      const urls: string[] = [];
      for (const { file, name } of group.files) {
        urls.push(
          await this.runIo(signal, () => prepared.upload!(file, name, signal))
        );
      }
      job.requestJson = {
        ...job.requestJson,
        [group.field]: group.scalar ? urls[0] : urls
      };
    }
    // Upload no longer needs the private input bytes. Never retain them
    // while waiting for the paid submission acknowledgement.
    await releasePreparedInputs?.();
    signal.throwIfAborted();
    await this.runIo(signal, () =>
      this.jobs.beginSubmission({
        ...job,
        keychainAccount: prepared.keychainAccount
      })
    );
    let requestId: string;
    try {
      signal.throwIfAborted();
      // The paid POST is not a transfer drain. Detach its acknowledgement on
      // retirement even if the transport ignores abort or holds body cleanup.
      // The durable reservation below prevents any replay of that attempt.
      requestId = await waitForInference(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return prepared.submit(job.requestJson, signal);
        }),
        signal
      );
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
    signal.throwIfAborted();
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
      await this.runIo(signal, () => this.jobs.settleRemoteJob(id, result));
    return this.requireJob(id);
  }

  /** Materialize a finished job in the library. Safe to retry after a restart. */
  async ingest(id: string, signal?: AbortSignal): Promise<ExternalRenderJob> {
    signal = signal
      ? AbortSignal.any([signal, this.work.capture()])
      : this.work.capture();
    signal.throwIfAborted();
    const existing = this.ingestions.get(id);
    if (existing && !existing.signal.aborted)
      return waitForInference(existing.operation, signal);
    // Retired authorization cannot occupy a restored profile's job slot.
    const entry = { signal, operation: this.ingestOutput(id, signal) };
    this.ingestions.set(id, entry);
    try {
      return await entry.operation;
    } finally {
      if (this.ingestions.get(id) === entry) this.ingestions.delete(id);
    }
  }

  private async ingestOutput(
    id: string,
    signal: AbortSignal
  ): Promise<ExternalRenderJob> {
    const job = await this.requireJob(id);
    if (job.status !== "OUTPUT_READY" || !job.outputJson || !job.requestId)
      return job;
    let output = job.outputJson;
    if (!output.urls.length)
      throw new Error("The provider returned no render outputs");
    const provider = this.providerFor(job.provider);
    const request = remoteRequest(job, job.requestId);
    // Authorize the saved account before fetching any stored URL. No key
    // lookup or network wait is necessary for this check.
    if (provider.assertOutputAccess)
      await provider.assertOutputAccess(request, signal);
    let files: Awaited<ReturnType<ExternalRenderAssets["download"]>>;
    try {
      files = await this.runIo(signal, () =>
        this.assets.download(job, output, signal)
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof RenderOutputUnavailable)) throw error;
      // URL renewal is not part of local transfer cleanup. A stalled GET
      // must not retain the ingestion slot or publish after retirement.
      const result = await waitForInference(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return provider.refresh(request, job.kind, signal);
        }),
        signal
      );
      signal.throwIfAborted();
      if (
        result.status !== "OUTPUT_READY" ||
        result.outputJson.urls.length !== output.urls.length
      )
        throw error;
      output = result.outputJson;
      files = await this.runIo(signal, () =>
        this.assets.download(job, output, signal)
      );
    }
    await this.runIo(signal, () =>
      this.jobs.finishIngestion(job, output, files)
    );
    return this.requireJob(id);
  }

  async cancel(id: string, signal?: AbortSignal): Promise<ExternalRenderJob> {
    signal = signal
      ? AbortSignal.any([signal, this.work.capture()])
      : this.work.capture();
    const job = await this.requireJob(id);
    signal.throwIfAborted();
    if (job.status !== "SUBMITTED" || !job.requestId) return job;
    const status = await this.providerFor(job.provider).cancel(
      remoteRequest(job, job.requestId),
      signal
    );
    signal.throwIfAborted();
    if (status === "CANCELLED")
      await this.runIo(signal, () => this.jobs.settleRemoteJob(id, { status }));
    if (status === "CANCELLATION_REQUESTED")
      await this.runIo(signal, () => this.jobs.markCancellationRequested(id));
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
