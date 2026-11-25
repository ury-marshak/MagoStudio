export const SETUP_PAUSED =
  "Paused. Click Resume and choose the same folder to continue.";

/** Only issued writes, transfers and children hold cleanup open. Native UI,
 * permission checks and inventory reads may outlive the retired attempt. */
export class SetupAttempt {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  readonly signal: AbortSignal;

  constructor(profile?: AbortSignal) {
    this.signal = profile
      ? AbortSignal.any([profile, this.controller.signal])
      : this.controller.signal;
  }

  pause(): void {
    this.controller.abort(new DOMException(SETUP_PAUSED, "AbortError"));
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  issue<T>(operation: () => Promise<T>): Promise<T> {
    return this.track(
      Promise.resolve().then(() => {
        this.signal.throwIfAborted();
        return operation();
      })
    );
  }

  async track<T>(pending: Promise<T>): Promise<T> {
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const { signal } = this;
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([operation(), aborted]);
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
