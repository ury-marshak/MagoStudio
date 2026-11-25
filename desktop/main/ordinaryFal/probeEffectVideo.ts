import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, stat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import ffmpegPath from "ffmpeg-static";

export interface EffectVideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  sizeBytes: number;
  presentationSignature: string;
}

const probeTimeoutMs = 60_000;
const maxPacketLineLength = 8192;
const discardPacketFlag = 0x4;
const microsecondsPerSecond = 1_000_000;
export const MAX_EFFECT_SOURCE_BYTES = 200_000_000;
const maxSourceSeconds = 10;
const minEditSeconds = 3;
const minEditEdge = 720;
const maxEditEdge = 2160;
const minEditFps = 24;
const maxEditFps = 60;
const maxUpscaleShortEdge = 1080;
const maxUpscaleLongEdge = 1920;
const fourCcBytes = 4;
const atomHeaderBytes = 8;
const extendedAtomHeaderBytes = 16;
const minFileTypePayloadBytes = 8;
const maxHeaderAtoms = 128;
const mp4OrMovBrand =
  /^(?:qt  |isom|iso[2-9]|mp4[12]|avc1|dash|M4V[HP ]|MSNV|F4V |XAVC|cmf[cv])$/;
const unreadableVideo = () =>
  new Error("Select a readable local MP4 or MOV video");
const cancelledProbe = () =>
  new DOMException("Video inspection was cancelled", "AbortError");

// FFmpeg framecrc columns: stream, DTS, PTS, duration, size, checksum, flags/side data.
// Stream 0 is the first real video stream; stream 1, when mapped, is audio.
export const createEffectVideoPacketParser = () => {
  let pending = "";
  let numerator = 0;
  let denominator = 0;
  let width = 0;
  let height = 0;
  let hasAudio = false;
  let firstPts = Infinity;
  let endPts = -Infinity;
  const presentationTimestamps: number[] = [];

  const readLine = (line: string) => {
    if (line.length > maxPacketLineLength) throw unreadableVideo();
    const timeBase = /^#tb 0: (\d+)\/(\d+)\s*$/.exec(line);
    if (timeBase) {
      numerator = Number(timeBase[1]);
      denominator = Number(timeBase[2]);
    }
    const dimensions = /^#dimensions 0: (\d+)x(\d+)\s*$/.exec(line);
    if (dimensions) {
      width = Number(dimensions[1]);
      height = Number(dimensions[2]);
    }
    if (line.trimEnd() === "#media_type 1: audio") hasAudio = true;
    if (!line.startsWith("0,")) return;

    const fields = line.split(",");
    // Discard-only preroll packets are not part of the presentation span.
    const flags = /^\s*F=0x([\da-f]+)\s*$/i.exec(fields[6] ?? "");
    if (flags && Number.parseInt(flags[1], 16) & discardPacketFlag) return;
    const pts = Number(fields[2]?.trim() || NaN);
    const duration = Number(fields[3]?.trim() || NaN);
    const end = pts + duration;
    if (
      !Number.isSafeInteger(pts) ||
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      !Number.isSafeInteger(end)
    ) {
      throw unreadableVideo();
    }
    firstPts = Math.min(firstPts, pts);
    endPts = Math.max(endPts, end);
    presentationTimestamps.push(pts);
  };

  return {
    read(chunk: string) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > maxPacketLineLength) throw unreadableVideo();
      for (const line of lines) readLine(line);
    },
    finish(): Omit<EffectVideoMetadata, "sizeBytes"> {
      if (pending) {
        readLine(pending);
        pending = "";
      }
      // Include the final presented sample, not just the gap between starts.
      const span = endPts - firstPts;
      if (
        ![numerator, denominator, width, height, span].every(
          (value) => Number.isSafeInteger(value) && value > 0
        )
      ) {
        throw unreadableVideo();
      }
      const durationSeconds = (span * numerator) / denominator;
      // Normalize away the stream start and time base, and hash in PTS order
      // (packets can arrive in decode order). Round to the nearest microsecond
      // using integer arithmetic: much finer than a frame or the editor’s ms
      // clock. Different rounding bins deliberately fail closed for placement.
      const scaledNumerator = BigInt(numerator) * BigInt(microsecondsPerSecond);
      const divisor = BigInt(denominator);
      const halfDivisor = divisor >> BigInt(1);
      const hash = createHash("sha256");
      for (const pts of presentationTimestamps.sort((a, b) => a - b)) {
        const offset = BigInt(pts - firstPts) * scaledNumerator;
        const microseconds = (offset + halfDivisor) / divisor;
        hash.update(`${microseconds},`);
      }
      // Report average presentation fps for VFR, not the nominal header rate.
      return {
        durationSeconds,
        width,
        height,
        fps: presentationTimestamps.length / durationSeconds,
        hasAudio,
        presentationSignature: `pts-us-v1:${hash.digest("hex")}`
      };
    }
  };
};

const packetListingArgs = (filePath: string) => [
  "-hide_banner",
  "-nostdin",
  "-loglevel",
  "error",
  "-xerror",
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov",
  "-enable_drefs",
  "0",
  "-copyts",
  "-i",
  filePath,
  "-map",
  "0:V:0",
  "-map",
  "0:a:0?",
  "-c",
  "copy",
  "-copyinkf",
  "-copytb",
  "1",
  "-avoid_negative_ts",
  "disabled",
  "-f",
  "framecrc",
  "-"
];

// FFmpeg uses the same demuxer for 3GP and other BMFF variants. Check the
// actual file type atom, not a suffix or FFmpeg's display name.
async function isMp4OrMov(
  file: FileHandle,
  sizeBytes: number,
  signal?: AbortSignal
) {
  const buffer = Buffer.alloc(extendedAtomHeaderBytes);
  let offset = 0;
  let hasMovieAtom = false;
  for (let atoms = 0; offset < sizeBytes && atoms < maxHeaderAtoms; atoms++) {
    if (signal?.aborted) throw cancelledProbe();
    const header = await file.read(buffer, 0, atomHeaderBytes, offset);
    if (header.bytesRead !== atomHeaderBytes) return false;
    const type = buffer.toString("latin1", fourCcBytes, atomHeaderBytes);
    let headerSize = atomHeaderBytes;
    let size = buffer.readUInt32BE(0);
    if (size === 1) {
      const extended = await file.read(
        buffer,
        0,
        atomHeaderBytes,
        offset + atomHeaderBytes
      );
      if (extended.bytesRead !== atomHeaderBytes) return false;
      headerSize = extendedAtomHeaderBytes;
      size = Number(buffer.readBigUInt64BE(0));
    } else if (size === 0) {
      size = sizeBytes - offset;
    }
    if (size < headerSize || size > sizeBytes - offset) return false;
    if (type === "ftyp") {
      if (size - headerSize < minFileTypePayloadBytes) return false;
      const brand = await file.read(
        buffer,
        0,
        minFileTypePayloadBytes,
        offset + headerSize
      );
      return (
        brand.bytesRead === minFileTypePayloadBytes &&
        mp4OrMovBrand.test(buffer.toString("latin1", 0, fourCcBytes))
      );
    }
    if (type === "moov") hasMovieAtom = true;
    offset += size;
  }
  // Legacy QuickTime can omit ftyp. FFmpeg still has to demux a video track.
  return offset === sizeBytes && hasMovieAtom;
}

export async function probeEffectVideo(
  filePath: string,
  signal?: AbortSignal
): Promise<EffectVideoMetadata> {
  if (signal?.aborted) throw cancelledProbe();
  if (!ffmpegPath)
    throw new Error("The bundled video inspector is unavailable");
  const executable = ffmpegPath.replace("app.asar", "app.asar.unpacked");
  let absolutePath: string;
  let sizeBytes: number;
  try {
    absolutePath = resolve(filePath);
    const info = await stat(absolutePath);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0)
      throw unreadableVideo();
    sizeBytes = info.size;
    const file = await open(absolutePath, "r");
    try {
      if (!(await isMp4OrMov(file, sizeBytes, signal))) throw unreadableVideo();
    } finally {
      await file.close();
    }
  } catch {
    throw signal?.aborted ? cancelledProbe() : unreadableVideo();
  }
  if (signal?.aborted) throw cancelledProbe();

  return new Promise((accept, reject) => {
    const parser = createEffectVideoPacketParser();
    let failure: Error | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, packetListingArgs(absolutePath), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      reject(unreadableVideo());
      return;
    }
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(cancelledProbe());
    const timer = setTimeout(
      () => stop(new Error("Video inspection timed out")),
      probeTimeoutMs
    );
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (failure) return;
      try {
        parser.read(chunk);
      } catch {
        stop(unreadableVideo());
      }
    });
    child.on("error", () => {
      failure ??= unreadableVideo();
    });
    // Neither kill nor exit guarantees the process and its stdio have closed.
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(cancelledProbe());
      else if (failure) reject(failure);
      else if (code !== 0) reject(unreadableVideo());
      else {
        try {
          accept({ ...parser.finish(), sizeBytes });
        } catch {
          reject(unreadableVideo());
        }
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function validateEffectVideo(
  metadata: EffectVideoMetadata,
  kind: "video-edit" | "video-upscale"
): void {
  const { durationSeconds, width, height, fps, sizeBytes } = metadata;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    ![width, height, sizeBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0
    )
  )
    throw unreadableVideo();
  if (sizeBytes > MAX_EFFECT_SOURCE_BYTES)
    throw new Error("Source video must be at most 200 MB");

  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  if (kind === "video-edit") {
    if (durationSeconds < minEditSeconds || durationSeconds > maxSourceSeconds)
      throw new Error(
        "Video editing requires a source between 3 and 10 seconds"
      );
    if (shortEdge < minEditEdge || longEdge > maxEditEdge)
      throw new Error(
        "Video editing requires both source dimensions to be between 720 and 2160 pixels"
      );
    if (fps < minEditFps || fps > maxEditFps)
      throw new Error("Video editing requires a source between 24 and 60 fps");
  } else {
    // App cap for the initial 2x upscale workflow, not a provider limit.
    if (
      durationSeconds > maxSourceSeconds ||
      shortEdge > maxUpscaleShortEdge ||
      longEdge > maxUpscaleLongEdge
    )
      throw new Error(
        "Video upscaling supports sources up to 10 seconds and 1080p (1920 × 1080 or 1080 × 1920)"
      );
  }
}
