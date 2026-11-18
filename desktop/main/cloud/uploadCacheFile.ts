import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";

import { runLibraryFfmpeg } from "../media/runLibraryFfmpeg";
import { publishFile, temporaryFile } from "../storage/atomicFile";

export const readFreshUploadSize = async (
  outputPath: string,
  sourcePath: string,
  signal?: AbortSignal
): Promise<number | null> => {
  signal?.throwIfAborted();
  // A missing cache entry must not release its still-issued sibling stat.
  const [output, source] = await Promise.allSettled([
    stat(outputPath),
    stat(sourcePath)
  ]);
  signal?.throwIfAborted();
  return output.status === "fulfilled" &&
    source.status === "fulfilled" &&
    output.value.size > 0 &&
    output.value.mtimeMs >= source.value.mtimeMs
    ? output.value.size
    : null;
};

export const encodeUploadCacheFile = async (input: {
  destination: string;
  args: (temporary: string) => string[];
  signal?: AbortSignal;
  message: string;
  timeoutMs?: number | null;
}): Promise<number> => {
  const { destination, signal } = input;
  signal?.throwIfAborted();
  if (!ffmpegPath) throw new Error("The bundled ffmpeg is unavailable");
  await mkdir(path.dirname(destination), { recursive: true });
  signal?.throwIfAborted();
  const temporary = temporaryFile(destination);
  try {
    await runLibraryFfmpeg(
      ffmpegPath.replace("app.asar", "app.asar.unpacked"),
      input.args(temporary),
      signal,
      input.message,
      input.timeoutMs
    );
    signal?.throwIfAborted();
    const { size } = await stat(temporary);
    signal?.throwIfAborted();
    if (!size) throw new Error("The prepared upload was empty");
    await publishFile(temporary, destination);
    return size;
  } finally {
    // Never expose a partial as a valid cache hit and never unlink before the
    // encoder has closed, even when it emitted an earlier error or exit.
    await rm(temporary, { force: true }).catch(() => {});
  }
};
