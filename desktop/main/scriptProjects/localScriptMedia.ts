/* oxlint-disable eslint/no-magic-numbers -- FFmpeg byte, frame-rate and selection bounds */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";

import { probeRenderedVideoMetadata } from "../cloud/probeRenderedVideoMetadata";

const FFMPEG_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_ERROR_LENGTH = 4000;

const executablePath = (): string => {
  if (!ffmpegPath) throw new Error("The bundled FFmpeg is unavailable");
  return ffmpegPath.replace("app.asar", "app.asar.unpacked");
};

const runImagePipe = async (
  args: string[],
  signal?: AbortSignal
): Promise<Buffer> => {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath(), args, {
      signal,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("FFmpeg timed out extracting a continuity frame"));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        child.kill();
        finish(new Error("FFmpeg continuity image is too large"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_ERROR_LENGTH);
    });
    child.once("error", finish);
    child.once("close", (code) => {
      if (code !== 0 || size === 0) {
        finish(
          new Error(
            `Unable to extract continuity image${stderr.trim() ? `: ${stderr.trim()}` : ""}`
          )
        );
        return;
      }
      finish();
    });
  });
};

const outputArgs = [
  "-frames:v",
  "1",
  "-c:v",
  "png",
  "-f",
  "image2pipe",
  "pipe:1"
];

export const extractFirstFrame = (
  filename: string,
  signal?: AbortSignal
): Promise<Buffer> =>
  runImagePipe(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filename,
      "-map",
      "0:v:0",
      ...outputArgs
    ],
    signal
  );

/** Script-shot videos run at 24 fps. Include the last decoded frame, not EOF. */
export const extractMetricsFrameGrid = (
  filename: string,
  timestamps: number[],
  durationSeconds: number,
  signal?: AbortSignal
): Promise<Buffer> => {
  const lastFrame = Math.max(0, Math.round(durationSeconds * 24) - 1);
  const indices = timestamps.map((time) =>
    Math.min(lastFrame, Math.round(time * 24))
  );
  return runImagePipe(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filename,
      "-map",
      "0:v:0",
      "-vf",
      `select='${indices.map((index) => `eq(n\\,${index})`).join("+")}',` +
        "scale=512:512:force_original_aspect_ratio=decrease," +
        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black," +
        `tile=2x2:nb_frames=${indices.length}:color=black`,
      ...outputArgs
    ],
    signal
  );
};

/** Try the bounded tail first; sparse video may end well before container EOF. */
export const extractLastFrame = async (
  filename: string,
  signal?: AbortSignal
): Promise<Buffer> => {
  try {
    return await runImagePipe(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-sseof",
        "-1",
        "-i",
        filename,
        "-map",
        "0:v:0",
        "-vf",
        "reverse",
        ...outputArgs
      ],
      signal
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    const metadata = await probeRenderedVideoMetadata(filename, signal);
    signal?.throwIfAborted();
    if (!metadata) throw error;
    // Decode from the start, retaining only the selected frame rather than
    // reversing the full video or buffering every decoded PNG.
    return runImagePipe(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        filename,
        "-map",
        "0:v:0",
        "-vf",
        `select=eq(n\\,${metadata.frameCount - 1})`,
        ...outputArgs
      ],
      signal
    );
  }
};

export const extractKeyframeGrid = (
  filename: string,
  durationSeconds: number,
  count: number,
  signal?: AbortSignal,
  fps = 24
): Promise<Buffer> => {
  const selected = Math.max(1, Math.min(4, Math.floor(count)));
  const frameCount = Math.max(1, Math.round(durationSeconds * fps));
  const indices = Array.from({ length: selected }, (_, index) =>
    Math.min(
      frameCount - 1,
      Math.round(((index + 1) / (selected + 1)) * (frameCount - 1))
    )
  );
  const select = indices.map((frame) => `eq(n\\,${frame})`).join("+");
  const filter = [
    `select=${select}`,
    "scale=512:-2:force_original_aspect_ratio=decrease",
    `tile=${selected}x1:nb_frames=${selected}:padding=4:margin=0`
  ].join(",");
  return runImagePipe(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filename,
      "-map",
      "0:v:0",
      "-vf",
      filter,
      ...outputArgs
    ],
    signal
  );
};

export const createReferenceGrid = (
  filenames: string[],
  signal?: AbortSignal
): Promise<Buffer> => {
  if (!filenames.length) throw new Error("A reference grid needs an image");
  const columns = Math.ceil(Math.sqrt(filenames.length));
  const rows = Math.ceil(filenames.length / columns);
  const inputs = filenames.flatMap((filename) => ["-i", filename]);
  const normalized = filenames.map(
    (_, index) =>
      `[${index}:v]scale=512:512:force_original_aspect_ratio=decrease,` +
      `pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black[v${index}]`
  );
  const layout = filenames
    .map(
      (_, index) => `${index % columns}*512_${Math.floor(index / columns)}*512`
    )
    .join("|");
  const stack =
    filenames.map((_, index) => `[v${index}]`).join("") +
    `xstack=inputs=${filenames.length}:layout=${layout}:fill=black[out]`;
  return runImagePipe(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      [...normalized, stack].join(";"),
      "-map",
      "[out]",
      "-s",
      `${columns * 512}x${rows * 512}`,
      ...outputArgs
    ],
    signal
  );
};

export const concatenateVideos = async (
  filenames: string[],
  signal?: AbortSignal
): Promise<Buffer> => {
  signal?.throwIfAborted();
  if (!filenames.length) throw new Error("The local cut has no videos");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mago-studio-cut-"));
  const manifest = path.join(temporaryRoot, "inputs.ffconcat");
  const output = path.join(temporaryRoot, "cut.mp4");
  try {
    const entries = filenames.map((filename) => {
      const normalized = path.resolve(filename).replaceAll("\\", "/");
      if (normalized.includes("\n") || normalized.includes("\r")) {
        throw new Error("A cut input path contains an unsupported newline");
      }
      return `file '${normalized.replaceAll("'", "'\\''")}'`;
    });
    await writeFile(manifest, ["ffconcat version 1.0", ...entries].join("\n"));
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executablePath(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          manifest,
          "-map",
          "0",
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          "-y",
          output
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      let failure: Error | undefined;
      const abort = () => {
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => {
        failure = new Error("FFmpeg timed out exporting the local cut");
        child.kill("SIGKILL");
      }, FFMPEG_TIMEOUT_MS);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_ERROR_LENGTH);
      });
      child.once("error", (error) => {
        failure = error;
        if (!child.pid) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code === 0) resolve();
        else
          reject(
            new Error(
              `Unable to export local cut${stderr.trim() ? `: ${stderr.trim()}` : ""}`
            )
          );
      });
    });
    signal?.throwIfAborted();
    return await readFile(output);
  } finally {
    const resolvedTemp = path.resolve(tmpdir());
    const resolvedTarget = path.resolve(temporaryRoot);
    if (resolvedTarget.startsWith(`${resolvedTemp}${path.sep}`)) {
      await rm(resolvedTarget, { recursive: true, force: true });
    }
  }
};
