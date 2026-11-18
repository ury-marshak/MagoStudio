import { spawn } from "node:child_process";

const TIMEOUT_MS = 60_000;
const MAX_ERROR_LENGTH = 2000;

/** Local decoding/encoding is drained through close, including stdio. Killing
 * a child (or receiving its error/exit event) does not yet release its files. */
export const runLibraryFfmpeg = (
  executable: string,
  args: string[],
  signal: AbortSignal | undefined,
  message: string,
  timeoutMs: number | null = TIMEOUT_MS
): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let output = "";
    let failure: unknown;
    const fail = (error: unknown) => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const abort = () => fail(signal?.reason);
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => fail(new Error(`Timed out: ${message}`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_ERROR_LENGTH);
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure || signal?.aborted) reject(failure ?? signal?.reason);
      else if (code === 0) resolve();
      else
        reject(
          new Error(`${message}${output.trim() ? `: ${output.trim()}` : ""}`)
        );
    });
  });
