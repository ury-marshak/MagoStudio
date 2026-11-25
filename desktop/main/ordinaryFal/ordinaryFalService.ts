import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type {
  FalProviderConfig,
  FalProviderMetadata
} from "../../shared/contracts";
import type {
  OrdinaryFalJob,
  OrdinaryFalSubmitResult
} from "../../shared/ordinaryFal";
import type { DatabaseManager } from "../database/databaseManager";
import { clearLibraryIssue, reportLibraryIssue } from "../libraryHealth";
import { LibraryWorkSession } from "../libraryWorkSession";
import { readExternalProviderKey } from "../providers/externalProviderSettings";
import { ExternalRenderAssets } from "../providers/externalRenderAssets";
import { ExternalRenderJobRepository } from "../providers/externalRenderJobRepository";
import { ExternalRenderJobService } from "../providers/externalRenderJobService";
import { FalRenderProvider } from "../providers/falRenderProvider";
import {
  type MediaRenderProvider,
  RenderSubmissionRejected
} from "../providers/mediaRenderProvider";
import type { ProfileIoDrain } from "../providers/profileIoDrain";
import { waitForInference } from "../providers/sharedInference";

import {
  type OrdinaryFalRecord,
  OrdinaryFalRepository
} from "./ordinaryFalRepository";
import {
  externalJobId,
  ordinaryFalEndpoint,
  ordinaryFalGetSchema,
  ordinaryFalListSchema,
  parseOrdinaryFalSubmission,
  prepareOrdinaryFalEffect,
  prepareOrdinaryFalRequest,
  publicJobId
} from "./ordinaryFalRequest";

const pollIntervalMs = 2500;
const recoveryIssueId = "Ordinary fal render recovery";

type Options = {
  databaseManager: DatabaseManager;
  getLibraryRoot: () => Promise<string | null>;
  getFal: () => Promise<FalProviderMetadata | null>;
  captureProfile: () => AbortSignal;
  readKey?: typeof readExternalProviderKey;
  profileIo?: Pick<ProfileIoDrain, "run">;
};
type Authorization = {
  config: FalProviderConfig;
  signal: AbortSignal;
  submissionId?: string;
};
type State = {
  initialized?: Promise<void>;
  recovery?: Promise<void>;
  workerStarted: boolean;
  preparing: Set<string>;
  errors: Map<string, string>;
};

const errorFor = (status: OrdinaryFalJob["status"]) => {
  switch (status) {
    case "NOT_SUBMITTED":
      return "The render was not submitted. Check the local inputs and fal configuration before starting a new render.";
    case "SUBMISSION_UNKNOWN":
      return "fal may have accepted this render. Check the provider request history before starting it again.";
    case "FAILED":
      return "fal rejected the render or reported a failure.";
    default:
      return null;
  }
};

export class OrdinaryFalService {
  private readonly work = new LibraryWorkSession<State>(() => ({
    preparing: new Set(),
    errors: new Map(),
    workerStarted: false
  }));
  private readonly authorization = new AsyncLocalStorage<Authorization>();
  private readonly repository: OrdinaryFalRepository;
  private readonly effectInputs: OrdinaryFalRepository;
  private readonly jobs: ExternalRenderJobService;

  constructor(private readonly options: Options) {
    const {
      databaseManager,
      getLibraryRoot,
      readKey = readExternalProviderKey
    } = options;
    this.effectInputs = new OrdinaryFalRepository(databaseManager);
    this.repository = this.work.guard(this.effectInputs);
    const getAuthorization = () => {
      const authorization = this.authorization.getStore();
      if (!authorization)
        throw new Error("No ordinary fal profile was captured");
      authorization.signal.throwIfAborted();
      return authorization;
    };
    const fal = new FalRenderProvider(
      async () => getAuthorization().config,
      async (account) => {
        const { config, signal } = getAuthorization();
        if (account !== config.keychainAccount)
          throw new Error(
            "The saved render belongs to another fal Keychain account"
          );
        const key = await readKey(account, signal);
        signal.throwIfAborted();
        return key;
      }
    );
    const provider: MediaRenderProvider = {
      prepareSubmission: async (endpoint, origin) => {
        const { config } = getAuthorization();
        // ExternalRenderJobService validates every local input before its first
        // upload. Don't enter Keychain until validation has completed.
        let prepared:
          | ReturnType<FalRenderProvider["prepareSubmission"]>
          | undefined;
        const prepare = () =>
          (prepared ??= fal.prepareSubmission(endpoint, origin));
        return {
          keychainAccount: config.keychainAccount,
          upload: async (file, name, signal) => {
            const client = await prepare();
            signal?.throwIfAborted();
            return client.upload(file, name, signal);
          },
          submit: async (input, signal) => {
            const client = await prepare();
            const authorization = getAuthorization();
            try {
              if (!authorization.submissionId)
                throw new Error("No ordinary fal reservation");
              await this.repository.assertDispatchRecorded(
                authorization.submissionId,
                authorization.signal
              );
            } catch (error) {
              throw new RenderSubmissionRejected(
                "The local fal submission could not be committed",
                { cause: error }
              );
            }
            signal?.throwIfAborted();
            return client.submit(input, signal);
          }
        };
      },
      assertOutputAccess: (request, signal) =>
        fal.assertOutputAccess(request, signal),
      refresh: (request, kind, signal) => fal.refresh(request, kind, signal),
      cancel: async () => {
        throw new Error("Ordinary fal cancellation is not exposed");
      }
    };
    // Same durable state machine and ingest paths as Director, with an isolated
    // lifecycle and project assets only (no Director media resolver).
    this.jobs = new ExternalRenderJobService(
      new ExternalRenderJobRepository(databaseManager),
      new Map([["fal", provider]]),
      new ExternalRenderAssets(databaseManager, getLibraryRoot),
      options.profileIo
    );
  }

  submit(
    input: unknown,
    origin: AbortSignal
  ): Promise<OrdinaryFalSubmitResult> {
    return this.work.run(async () => {
      const rejection = (message: string): OrdinaryFalSubmitResult => ({
        status: "rejected",
        message
      });
      const configChanged = () =>
        rejection(
          "The fal account or configuration changed. Review Settings → Providers before confirming again."
        );
      let signal: AbortSignal;
      try {
        signal = this.operationSignal(origin);
      } catch {
        // No reservation exists for this call. Provider settings may be saving.
        origin.throwIfAborted();
        this.work.capture();
        return configChanged();
      }
      let payload: ReturnType<typeof parseOrdinaryFalSubmission>;
      try {
        payload = parseOrdinaryFalSubmission(input);
      } catch (error) {
        return rejection(
          error instanceof Error && error.constructor === Error
            ? error.message
            : "Invalid ordinary fal request. Review your inputs and try again."
        );
      }
      const { parsed, expectedFal } = payload;
      const { input: request } = parsed;
      const id = externalJobId(request.id);
      const inputDigest = createHash("sha256")
        .update(
          JSON.stringify({
            ...request,
            expectedFal,
            settings: Object.fromEntries(
              Object.entries(
                (parsed.mode === "generate"
                  ? parsed.input.settings
                  : undefined) ?? {}
              ).sort(([a], [b]) => a.localeCompare(b))
            )
          })
        )
        .digest("hex");
      const readReserved = async () => {
        const row = await this.repository.get(id);
        signal.throwIfAborted();
        return row;
      };
      const mismatched = (row: OrdinaryFalRecord) =>
        row.editor.inputDigest !== inputDigest;
      const conflictMessage =
        "This fal submission ID already belongs to a different request";
      let preview:
        | Awaited<ReturnType<OrdinaryFalRepository["prepareEffect"]>>
        | undefined;
      let finishPreviewDrain: (() => void) | undefined;
      const disposePreview = async () => {
        try {
          if (preview) {
            await preview.dispose();
            preview = undefined;
          }
        } finally {
          finishPreviewDrain?.();
        }
      };
      let reservationStarted = false;
      try {
        await this.initialize();
        const existing = await readReserved();
        if (existing)
          return mismatched(existing)
            ? rejection(conflictMessage)
            : { status: "job", job: this.status(existing) };
        const config = await this.options.getFal();
        signal.throwIfAborted();
        if (
          !config ||
          config.keychainAccount !== expectedFal.keychainAccount ||
          config.revision !== expectedFal.revision
        )
          return configChanged();
        if (parsed.mode === "effect") {
          signal.throwIfAborted();
          if (this.options.profileIo) {
            // The prepared Blob is backed by a private file. Enlist before
            // the copy starts and release after upload, not after the POST.
            const pending = new Promise<void>((resolve) => {
              finishPreviewDrain = resolve;
            });
            void this.options.profileIo
              .run(signal, () => pending)
              .catch(() => {});
          }
          await this.work.boundary(async () => {
            preview = await this.effectInputs.prepareEffect(
              parsed.input,
              this.options.getLibraryRoot,
              signal
            );
          });
        }
        const destination =
          preview?.destination ??
          (parsed.mode === "generate" ? parsed.destination : undefined);
        if (!destination) throw new Error("No fal render destination");
        const projectDefaults =
          parsed.mode === "generate"
            ? await this.repository.validateDestination(
                request.projectId,
                request.shotId,
                parsed.destination,
                signal
              )
            : undefined;
        const prepared =
          parsed.mode === "effect" &&
          (destination.kind === "video-edit" ||
            destination.kind === "video-upscale")
            ? prepareOrdinaryFalEffect(parsed.input, destination)
            : parsed.mode === "generate"
              ? prepareOrdinaryFalRequest(
                  parsed,
                  config,
                  projectDefaults?.[request.model]
                )
              : undefined;
        if (!prepared) throw new Error("No fal render destination");
        const { submission, effectiveSettings } = prepared;
        // The reservation is the idempotency claim: only the caller that first
        // inserted it can POST. Recovery never submits even if only this row exists.
        signal.throwIfAborted();
        reservationStarted = true;
        const reserve = () =>
          this.repository.reserve({
            jobId: id,
            projectId: request.projectId,
            shotId: request.shotId,
            model: request.model,
            kind: request.kind,
            inputDigest,
            keychainAccount: config.keychainAccount,
            destination,
            effectiveSettings
          });
        const reserved = await (this.options.profileIo?.run(signal, reserve) ??
          reserve());
        signal.throwIfAborted();
        if (reserved) {
          this.work.state.preparing.add(id);
          try {
            await this.authorization.run(
              { config, signal, submissionId: id },
              () =>
                this.jobs.submit(
                  submission,
                  signal,
                  preview &&
                    new Map([
                      [preview.destination.sourceAssetId, preview.input]
                    ]),
                  preview && disposePreview
                )
            );
          } catch {
            // The durable job distinguishes definite rejection from an uncertain
            // POST. Never expose raw transport errors (which may include URLs).
            signal.throwIfAborted();
          } finally {
            this.work.state.preparing.delete(id);
          }
        }
        const row = await readReserved();
        if (!row)
          throw new Error(
            "The fal render's local project is no longer available"
          );
        if (mismatched(row)) return rejection(conflictMessage);
        return { status: "job", job: this.status(row) };
      } catch (error) {
        if (reservationStarted) {
          signal.throwIfAborted();
          throw error;
        }
        origin.throwIfAborted();
        this.work.capture();
        if (signal.aborted) return configChanged();
        return rejection(
          error instanceof Error &&
            error.constructor === Error &&
            !("code" in error) &&
            !error.cause
            ? error.message
            : "Could not validate the local fal request. Review your inputs and try again."
        );
      } finally {
        await disposePreview().catch(() => {});
      }
    });
  }

  get(input: unknown, origin: AbortSignal) {
    return this.work.run(async () => {
      const signal = this.operationSignal(origin);
      const { id } = ordinaryFalGetSchema.parse(input);
      await this.initialize();
      const row = await this.repository.get(externalJobId(id));
      signal.throwIfAborted();
      return row ? this.status(row) : null;
    });
  }

  list(input: unknown, origin: AbortSignal) {
    return this.work.run(async () => {
      const signal = this.operationSignal(origin);
      const { projectId } = ordinaryFalListSchema.parse(input ?? {});
      await this.initialize();
      const rows = await this.repository.list(projectId);
      signal.throwIfAborted();
      return rows.map((row) => this.status(row));
    });
  }

  /** Start after the database opens. A tick can only refresh/ingest/attach. */
  start(): void {
    const signal = this.work.capture();
    if (this.work.state.workerStarted) return;
    this.work.state.workerStarted = true;
    const schedule = (delay: number) => {
      if (signal.aborted) return;
      const abort = () => clearTimeout(timer);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return;
        void this.recover()
          .then(
            () => {
              if (!signal.aborted) clearLibraryIssue(recoveryIssueId);
            },
            () => {
              if (!signal.aborted)
                reportLibraryIssue({
                  id: recoveryIssueId,
                  kind: "service",
                  message:
                    "Could not check saved fal renders. The app will try again."
                });
            }
          )
          .finally(() => schedule(pollIntervalMs));
      }, delay);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });
    };
    schedule(0);
  }

  recover(): Promise<void> {
    return this.work.run(async () => {
      const state = this.work.state;
      const recovery = (state.recovery ??= this.recoverOnce());
      try {
        await recovery;
      } finally {
        if (state.recovery === recovery) state.recovery = undefined;
      }
    });
  }

  stop(): void {
    this.work.stop();
    this.jobs.stop();
  }

  async suspend(): Promise<void> {
    await Promise.all([this.work.suspend(), this.jobs.suspend()]);
  }

  reset(): void {
    this.work.reset();
    this.jobs.reset();
    this.start();
  }

  private operationSignal(origin?: AbortSignal) {
    const signal = AbortSignal.any([
      this.work.capture(),
      this.options.captureProfile(),
      ...(origin ? [origin] : [])
    ]);
    signal.throwIfAborted();
    return signal;
  }

  private initialize() {
    const state = this.work.state;
    return (state.initialized ??= this.repository
      .markInterrupted()
      .catch((error) => {
        state.initialized = undefined;
        throw error;
      }));
  }

  private async recoverOnce() {
    let signal: AbortSignal;
    try {
      signal = this.operationSignal();
    } catch {
      // The account/provider epoch can be temporarily closed during transitions.
      return;
    }
    await this.initialize();
    if (signal.aborted) return;
    const config = await this.options.getFal();
    if (!config || signal.aborted) return;
    const rows = await this.repository.recoverable(config.keychainAccount);
    for (const { editor, job } of rows) {
      if (signal.aborted) return;
      if (
        !job ||
        job.projectId !== editor.projectId ||
        job.provider !== "fal" ||
        job.endpoint !== ordinaryFalEndpoint(editor.model) ||
        job.keychainAccount !== config.keychainAccount
      )
        continue;
      const id = editor.jobId;
      try {
        await this.authorization.run({ config, signal }, async () => {
          let updated = job;
          if (
            updated.status === "SUBMITTED" ||
            updated.status === "CANCELLATION_REQUESTED"
          )
            updated = await waitForInference(
              this.jobs.refresh(id, signal),
              signal
            );
          if (updated.status === "OUTPUT_READY")
            updated = await waitForInference(
              this.jobs.ingest(id, signal),
              signal
            );
          signal.throwIfAborted();
          if (updated.status === "INGESTED") {
            const attach = () =>
              this.repository.attach({ editor, job: updated }, signal);
            await (this.options.profileIo?.run(signal, attach) ?? attach());
          }
        });
        this.work.state.errors.delete(id);
      } catch {
        if (signal.aborted) return;
        this.work.state.errors.set(
          id,
          "Could not check or place this fal render. The app will try again without resubmitting."
        );
      }
    }
  }

  private status({ editor, job }: OrdinaryFalRecord): OrdinaryFalJob {
    const status =
      job?.status === "OUTPUT_READY"
        ? "COMPLETED"
        : (job?.status ??
          (this.work.state.preparing.has(editor.jobId)
            ? "PREPARING"
            : "NOT_SUBMITTED"));
    return {
      id: publicJobId(editor.jobId),
      kind: editor.kind,
      model: editor.model,
      projectId: editor.projectId,
      shotId: editor.shotId,
      status,
      placement: editor.placement,
      assetIds: job?.outputJson?.assetIds ?? [],
      clipId: editor.clipId,
      ...((editor.kind === "video-edit" || editor.kind === "video-upscale") &&
      editor.placement === "UNATTACHED"
        ? {
            warning:
              "The source changed or the result did not match the saved timing, audio, or upscale dimensions. The result is available separately in local history."
          }
        : {}),
      error:
        errorFor(status) ?? this.work.state.errors.get(editor.jobId) ?? null
    };
  }
}
