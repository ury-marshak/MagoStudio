/* oxlint-disable eslint/no-magic-numbers -- bounded FFmpeg media preparation */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";

import { probeRenderedVideoMetadata } from "../cloud/probeRenderedVideoMetadata";

const OUTPUT_FPS = 24;
const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

/** Credential-free preparation data; callers bind source/output asset IDs. */
import type { VideoTailProvenance } from "../../shared/falVideoTail";
export type { VideoTailProvenance } from "../../shared/falVideoTail";

const runFfmpeg = async (
  args: string[],
  signal?: AbortSignal,
  onLine?: (line: string) => void
): Promise<void> => {
  signal?.throwIfAborted();
  if (!ffmpegPath) throw new Error("The bundled FFmpeg is unavailable");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath!.replace("app.asar", "app.asar.unpacked"),
      args,
      {
        signal,
        killSignal: "SIGKILL",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stderr = "";
    let pending = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg timed out preparing the continuity video"));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) onLine(line);
      if (pending.length > 4096) {
        child.kill("SIGKILL");
        finish(new Error("Invalid FFmpeg packet listing"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.once("error", finish);
    child.once("close", (code) => {
      if (pending) onLine?.(pending);
      finish(
        code === 0
          ? undefined
          : new Error(`Unable to prepare continuity video: ${stderr.trim()}`)
      );
    });
  });
  signal?.throwIfAborted();
};

/** Read packet timing with bounded memory; refuse VFR/gaps rather than guess a tail from nominal fps. */
const probeConstantRate = async (filename: string, signal?: AbortSignal) => {
  let timeBase = 0;
  let frameCount = 0;
  let duration = 0;
  let previousDts: number | undefined;
  let minPts = Infinity;
  let maxPts = -Infinity;
  let valid = true;
  await runFfmpeg(
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      filename,
      "-map",
      "0:v:0",
      "-c",
      "copy",
      "-f",
      "framecrc",
      "pipe:1"
    ],
    signal,
    (line) => {
      const base = /^#tb 0: (\d+)\/(\d+)/.exec(line);
      if (base) timeBase = Number(base[1]) / Number(base[2]);
      if (!line || line.startsWith("#")) return;
      const fields = line.split(",").map((field) => Number(field.trim()));
      const [stream, dts, pts, packetDuration] = fields;
      if (
        fields.length < 6 ||
        stream !== 0 ||
        !Number.isFinite(dts) ||
        !Number.isFinite(pts) ||
        !Number.isFinite(packetDuration) ||
        packetDuration! <= 0
      ) {
        valid = false;
        return;
      }
      duration ||= packetDuration!;
      if (
        packetDuration !== duration ||
        (previousDts !== undefined && dts! - previousDts !== duration)
      )
        valid = false;
      previousDts = dts;
      minPts = Math.min(minPts, pts!);
      maxPts = Math.max(maxPts, pts!);
      frameCount++;
    }
  );
  const fps = 1 / (timeBase * duration);
  if (
    !valid ||
    !frameCount ||
    !Number.isFinite(fps) ||
    fps < 1 ||
    fps > 120 ||
    maxPts - minPts + duration !== frameCount * duration
  )
    throw new Error(
      "Continuity video requires a constant-frame-rate source without timestamp gaps"
    );
  return { frameCount, fps };
};

/**
 * Local media preparation only: one silent H.264 MP4, 24 fps, bounded to 1280×720
 * and 64 MiB. No upload/submission. Sources shorter than fal's 2s minimum fail
 * closed instead of padding invented motion or sending the entire predecessor.
 * Director last_chunk stays gated until mapping/recovery/cost integration lands.
 */
export const prepareVideoTail = async (
  filename: string,
  seconds: number,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; provenance: VideoTailProvenance }> => {
  signal?.throwIfAborted();
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 10)
    throw new Error("Continuity video tail must be between 2 and 10 seconds");
  const source = await probeConstantRate(filename, signal);
  const selected = Math.min(
    source.frameCount,
    Math.ceil(seconds * source.fps - 1e-6)
  );
  // Include enough source frames for fractional rates, but never extend the
  // encoded tail beyond the requested duration.
  const outputFrames = Math.floor(
    Math.min(seconds, selected / source.fps) * OUTPUT_FPS + 1e-6
  );
  if (outputFrames < 2 * OUTPUT_FPS)
    throw new Error(
      "The preceding video is shorter than the 2-second reference minimum"
    );
  const start = source.frameCount - selected;
  const directory = await mkdtemp(path.join(tmpdir(), "mago-video-tail-"));
  const output = path.join(directory, "tail.mp4");
  try {
    await runFfmpeg(
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-xerror",
        "-i",
        filename,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-vf",
        `trim=start_frame=${start},setpts=N/(${source.fps}*TB),tpad=stop_mode=clone:stop_duration=1,fps=${OUTPUT_FPS},scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
        "-frames:v",
        String(outputFrames),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-fs",
        String(MAX_BYTES),
        output
      ],
      signal
    );
    const info = await stat(output);
    if (!info.size || info.size >= MAX_BYTES)
      throw new Error(
        "Continuity video tail exceeds the preparation size limit"
      );
    const measured = await probeRenderedVideoMetadata(output, signal);
    signal?.throwIfAborted();
    if (
      !measured ||
      measured.frameCount !== outputFrames ||
      measured.fps !== OUTPUT_FPS ||
      !measured.width ||
      !measured.height
    )
      throw new Error("Prepared continuity video failed media validation");
    const bytes = await readFile(output);
    signal?.throwIfAborted();
    return {
      bytes,
      provenance: {
        profile: "h3-tail-cfr-720p-v1",
        requested_seconds: seconds,
        source_frame_count: source.frameCount,
        source_fps: source.fps,
        start_frame: start,
        end_frame_exclusive: source.frameCount,
        selected_frame_count: selected,
        output_frame_count: measured.frameCount,
        output_fps: OUTPUT_FPS,
        output_duration_seconds: measured.frameCount / OUTPUT_FPS,
        output_width: measured.width,
        output_height: measured.height,
        audio: false
      }
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
