import { spawn } from "node:child_process";

import ffmpegPath from "ffmpeg-static";

const FFMPEG_PROBE_TIMEOUT_MS = 15_000;
const MAX_PROBE_OUTPUT_LENGTH = 20_000;
const VIDEO_STREAM_LINE = /Stream #\d+:\d+.*?: Video: (.*)$/m;
const STREAM_DIMENSIONS = /(?:^|[\s,])(\d+)x(\d+)(?=[\s,[]|$)/;

export interface ImageDimensions {
  width: number;
  height: number;
}

export const parseFfmpegVideoStreamDimensions = (
  ffmpegOutput: string
): ImageDimensions | null => {
  const videoStreamDescription = VIDEO_STREAM_LINE.exec(ffmpegOutput)?.[1];
  if (!videoStreamDescription) return null;
  const dimensionsMatch = STREAM_DIMENSIONS.exec(videoStreamDescription);
  if (!dimensionsMatch) return null;
  const width = Number(dimensionsMatch[1]);
  const height = Number(dimensionsMatch[2]);
  return width > 0 && height > 0 ? { width, height } : null;
};

const ffmpegExecutablePath = (): string | null =>
  ffmpegPath ? ffmpegPath.replace("app.asar", "app.asar.unpacked") : null;

export const probeImageDimensions = async (
  filePath: string,
  signal?: AbortSignal
): Promise<ImageDimensions | null> => {
  signal?.throwIfAborted();
  const executablePath = ffmpegExecutablePath();
  if (!executablePath) return null;
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["-hide_banner", "-i", filePath], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let probeOutput = "";
    const kill = () => {
      if (!child.killed) child.kill("SIGKILL");
    };
    const timer = setTimeout(kill, FFMPEG_PROBE_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      probeOutput = `${probeOutput}${chunk.toString()}`.slice(
        0,
        MAX_PROBE_OUTPUT_LENGTH
      );
    });
    // FFmpeg's probe-only invocation does not need a successful exit code.
    // Spawn errors and timeouts still have to wait for stdio close.
    child.on("error", () => {});
    child.once("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) reject(signal.reason);
      else resolve(parseFfmpegVideoStreamDimensions(probeOutput));
    });
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
  });
};
