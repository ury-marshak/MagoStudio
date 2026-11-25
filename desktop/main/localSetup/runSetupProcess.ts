import { spawn } from "node:child_process";

/** Abort asks Node to kill the owned child. Only close acknowledges that the
 * process and stdio are gone and its staging directory can be cleaned up. */
export const runSetupProcess = (
  command: string,
  args: string[],
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { windowsHide: true, signal, env });
    let output = "";
    let error: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (failure) => {
      error ??= failure;
    });
    child.once("close", (exitCode) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve({ exitCode, output });
    });
  });
