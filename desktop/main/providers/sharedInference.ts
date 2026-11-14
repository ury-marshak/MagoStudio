/** Wait without transferring cancellation ownership to a shared operation. */
export const waitForInference = <T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
};

type Entry<T> = {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
};

/** One paid operation per key; abort it only when its last consumer leaves. */
export class SharedInference<T> {
  private readonly entries = new Map<string, Entry<T>>();

  async run(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    signal.throwIfAborted();
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: Entry<T> = {
        controller,
        subscribers: 0,
        promise: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return start(controller.signal);
        })
      };
      entry = created;
      this.entries.set(key, created);
      // Attach both handlers immediately, including for a pre-start abort.
      void created.promise.then(
        () => this.remove(key, created),
        () => this.remove(key, created)
      );
    }
    entry.subscribers += 1;
    try {
      return await waitForInference(entry.promise, signal);
    } finally {
      entry.subscribers -= 1;
      if (!entry.subscribers) {
        this.remove(key, entry);
        entry.controller.abort();
      }
    }
  }

  private remove(key: string, entry: Entry<T>): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}
