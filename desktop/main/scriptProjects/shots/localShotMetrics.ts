import { runBackgroundTask } from "../../libraryHealth";
import type { ShotVideoEvaluationInput } from "../../vlm/videoMetrics";

type Metrics = Record<string, unknown>;
type Dependencies = {
  resolveInput: (
    assetId: string,
    signal: AbortSignal
  ) => Promise<ShotVideoEvaluationInput>;
  read: (assetId: string) => Promise<Metrics | null>;
  write: (assetId: string, metrics: Metrics) => Promise<void>;
  evaluate: (
    input: ShotVideoEvaluationInput,
    signal: AbortSignal
  ) => Promise<Metrics>;
};

const base = () => ({
  version: "v1",
  eval_mode: "image_to_video",
  score: null,
  vid_score: null,
  vid_pass: null,
  vid_issues: [],
  vid_next_prompt: null
});

/** Persisted per-video jobs. Opening an older version starts its first evaluation. */
export class LocalShotMetrics {
  private readonly requests = new Map<string, Promise<Metrics>>();
  private readonly running = new Map<string, Metrics>();
  private session = new AbortController();
  private readonly writes = new Set<Promise<void>>();

  constructor(private readonly dependencies: Dependencies) {}

  /** Capture before any asynchronous input lookup, not after library replacement. */
  captureSession(): AbortSignal {
    this.session.signal.throwIfAborted();
    return this.session.signal;
  }

  stop(): void {
    this.session.abort();
    this.requests.clear();
    this.running.clear();
  }

  async suspend(): Promise<void> {
    this.stop();
    // Do not wait for an inference provider which may ignore abort. Only database
    // operations already issued must finish before the database can be replaced.
    await Promise.allSettled(this.writes);
  }

  reset(): void {
    if (!this.session.signal.aborted)
      throw new Error("Suspend shot metrics before reset");
    this.session = new AbortController();
  }

  get(assetId: string, signal = this.captureSession()): Promise<Metrics> {
    signal.throwIfAborted();
    if (signal !== this.session.signal)
      throw new Error("Expired shot metrics session");
    const active = this.running.get(assetId);
    if (active) return Promise.resolve(active);
    const existing = this.requests.get(assetId);
    if (existing) return existing;
    const request = this.readOrStart(assetId, signal).finally(() => {
      if (this.requests.get(assetId) === request) this.requests.delete(assetId);
    });
    this.requests.set(assetId, request);
    return request;
  }

  private async write(
    assetId: string,
    value: Metrics,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    const operation = this.dependencies.write(assetId, value);
    this.writes.add(operation);
    try {
      await operation;
      signal.throwIfAborted();
    } finally {
      this.writes.delete(operation);
    }
  }

  private async readOrStart(
    assetId: string,
    signal: AbortSignal
  ): Promise<Metrics> {
    signal.throwIfAborted();
    const stored = await this.dependencies.read(assetId);
    signal.throwIfAborted();
    if (stored?.status === "COMPLETED" || stored?.status === "FAILED")
      return stored;
    // A persisted PENDING without an in-process job was interrupted by restart.
    // Re-run it using its immutable render inputs rather than poll forever.
    const pending = {
      ...base(),
      status: "PENDING",
      started_at: new Date().toISOString()
    };
    await this.write(assetId, pending, signal);
    signal.throwIfAborted();
    this.running.set(assetId, pending);
    void runBackgroundTask(`Shot metrics ${assetId}`, () =>
      this.evaluate(assetId, pending, signal)
    );
    return pending;
  }

  private async evaluate(
    assetId: string,
    pending: Metrics,
    signal: AbortSignal
  ): Promise<void> {
    let stage = "input";
    let result: Metrics;
    try {
      signal.throwIfAborted();
      const input = await this.dependencies.resolveInput(assetId, signal);
      signal.throwIfAborted();
      stage = "evaluate";
      const metrics = await this.dependencies.evaluate(input, signal);
      signal.throwIfAborted();
      result = {
        ...pending,
        ...metrics,
        status: "COMPLETED",
        error: null
      };
    } catch (error) {
      if (signal.aborted) return;
      result = {
        ...pending,
        status: "FAILED",
        error: {
          stage,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
    if (signal.aborted) return;
    result.finished_at = new Date().toISOString();
    try {
      await this.write(assetId, result, signal);
      signal.throwIfAborted();
      this.running.delete(assetId);
    } catch (error) {
      if (signal.aborted) return;
      // Stop pollers even if a library disk disappears during evaluation.
      this.running.set(assetId, {
        ...pending,
        status: "FAILED",
        error: {
          stage: "persist",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}
