import { LibraryWorkSession } from "../libraryWorkSession";

/** Keep an issued body owned until EOF, consumer cancellation, or teardown.
 * Cancelling the reader closes the underlying file/network stream; suspension
 * drains that cleanup, not merely the promise that returned response headers.
 */
export const libraryMediaStream = (
  body: ReadableStream<Uint8Array>,
  work: LibraryWorkSession<undefined>,
  signal: AbortSignal,
  trackCleanup?: (closed: Promise<void>) => void
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // Register before returning the response; detached cleanup retains this session.
  trackCleanup?.(done);
  void work.boundary(() => done).catch(() => {});
  const release = () => {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
    finish();
  };
  const cancel = async (reason: unknown) => {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };
  const abort = () => {
    if (closed) return;
    controller.error(signal.reason);
    void cancel(signal.reason).catch(() => {});
  };
  return new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull() {
        try {
          const result = await reader.read();
          if (closed) return;
          signal.throwIfAborted();
          if (result.done) {
            closed = true;
            controller.close();
            release();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          if (closed) return;
          controller.error(error);
          await cancel(error);
        }
      },
      cancel
    },
    { highWaterMark: 0 }
  );
};
