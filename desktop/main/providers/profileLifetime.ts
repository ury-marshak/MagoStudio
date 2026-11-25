/** Profile permission/configuration epochs do not own the current library.
 * Retiring an epoch revokes client work, not jobs already accepted remotely.
 */
export class ProfileLifetime {
  private controller = new AbortController();

  capture(): AbortSignal {
    this.controller.signal.throwIfAborted();
    return this.controller.signal;
  }

  suspend(): void {
    this.controller.abort(
      new DOMException("The app profile changed", "AbortError")
    );
  }

  resume(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }

  rotate(): void {
    this.suspend();
    this.resume();
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.capture();
    const result = await operation(signal);
    signal.throwIfAborted();
    return result;
  }
}
