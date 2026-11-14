import { execFileSync, spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { prepareVideoTail } from "./prepareVideoTail";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let directory: string;
let source: string;
let short: string;
let variable: string;
let fractional: string;

const ffmpeg = (args: string[]) =>
  execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", ...args], {
    timeout: 10000
  });

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mago-tail-test-"));
  source = path.join(directory, "red-then-blue-with-long-audio.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=red:size=64x48:rate=12:duration=2",
    "-f",
    "lavfi",
    "-i",
    "color=blue:size=64x48:rate=12:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=7",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    source
  ]);
  short = path.join(directory, "short.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x48:rate=24:duration=1",
    "-c:v",
    "libx264",
    short
  ]);
  variable = path.join(directory, "timestamp-gap.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x48:rate=24:duration=3",
    "-vf",
    "setpts=if(gte(N\\,24)\\,PTS+1/TB\\,PTS)",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    variable
  ]);
  fractional = path.join(directory, "fractional.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x48:rate=30000/1001:duration=4",
    "-c:v",
    "libx264",
    fractional
  ]);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(spawn).mockClear();
});

const writeTail = async (bytes: Buffer) => {
  const output = path.join(directory, "tail.mp4");
  await writeFile(output, bytes);
  return output;
};

it("prepares the actual tail at measured source fps, ignoring longer audio, and records frame provenance", async () => {
  const controller = new AbortController();
  const { bytes, provenance } = await prepareVideoTail(
    source,
    2,
    controller.signal
  );
  expect(provenance).toMatchObject({
    profile: "h3-tail-cfr-720p-v1",
    requested_seconds: 2,
    source_frame_count: 48,
    source_fps: 12,
    start_frame: 24,
    end_frame_exclusive: 48,
    selected_frame_count: 24,
    output_frame_count: 48,
    output_fps: 24,
    output_duration_seconds: 2,
    audio: false
  });
  expect(provenance.output_width).toBeLessThanOrEqual(1280);
  expect(provenance.output_height).toBeLessThanOrEqual(720);
  const output = await writeTail(bytes);
  const pixel = ffmpeg([
    "-i",
    output,
    "-frames:v",
    "1",
    "-vf",
    "scale=1:1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1"
  ]);
  expect(pixel[2]).toBeGreaterThan(200); // blue tail, not red opening
  expect(pixel[0]).toBeLessThan(30);
  expect(
    ffmpeg([
      "-i",
      output,
      "-map",
      "0",
      "-c",
      "copy",
      "-f",
      "framecrc",
      "pipe:1"
    ]).toString()
  ).not.toContain("#media_type 1: audio");
  const encode = vi
    .mocked(spawn)
    .mock.calls.find((call) => (call[1] as string[]).includes("libx264"))!;
  await expect(
    readdir(path.dirname((encode[1] as string[]).at(-1)!))
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("clamps a tail request to the complete available video without padding to the requested duration", async () => {
  const { provenance } = await prepareVideoTail(source, 10);
  expect(provenance).toMatchObject({
    requested_seconds: 10,
    start_frame: 0,
    selected_frame_count: 48,
    output_frame_count: 96,
    output_duration_seconds: 4
  });
});

it.each([2, 2.5])(
  "handles fractional source fps at %s seconds without dropping below the provider minimum",
  async (seconds) => {
    const { provenance } = await prepareVideoTail(fractional, seconds);
    expect(provenance.source_fps).toBeCloseTo(30000 / 1001, 5);
    expect(provenance.selected_frame_count).toBe(
      Math.ceil((seconds * 30000) / 1001)
    );
    expect(provenance.output_frame_count).toBe(seconds * 24);
    expect(provenance.output_duration_seconds).toBe(seconds);
  }
);

it.each([0, 1.99, 10.01, Infinity, NaN])(
  "rejects invalid requested duration %s without starting FFmpeg",
  async (seconds) => {
    await expect(prepareVideoTail(source, seconds)).rejects.toThrow(
      "between 2 and 10"
    );
    expect(spawn).not.toHaveBeenCalled();
  }
);

it("refuses a source below the provider minimum instead of padding invented continuity", async () => {
  await expect(prepareVideoTail(short, 2)).rejects.toThrow(
    "shorter than the 2-second"
  );
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("refuses timestamp gaps/VFR instead of treating nominal fps as actual duration", async () => {
  await expect(prepareVideoTail(variable, 2)).rejects.toThrow(
    "constant-frame-rate"
  );
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("rejects a pre-aborted request without starting FFmpeg", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareVideoTail(source, 2, controller.signal)
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(spawn).not.toHaveBeenCalled();
});

it("kills an in-flight timing probe without leaving an abort listener", async () => {
  const controller = new AbortController();
  const pending = prepareVideoTail(source, 2, controller.signal);
  const child = vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<
    typeof spawn
  >;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve())
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError"
  });
  controller.abort();
  await rejected;
  await closed;
  expect(child.killed).toBe(true);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("cleans the temporary directory when encoding is cancelled", async () => {
  const controller = new AbortController();
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  let output: string | undefined;
  let closed: Promise<void> | undefined;
  vi.mocked(spawn).mockImplementation((...args) => {
    const child = actual.spawn(...args);
    const command = args[1] as string[];
    if (command.includes("libx264")) {
      output = command.at(-1);
      closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      );
      queueMicrotask(() => controller.abort());
    }
    return child;
  });
  try {
    await expect(
      prepareVideoTail(source, 2, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    await closed;
    expect(output).toBeDefined();
    await expect(readdir(path.dirname(output!))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    vi.mocked(spawn).mockImplementation(actual.spawn);
  }
});

it("rejects missing or undecodable sources before encoding", async () => {
  await expect(
    prepareVideoTail(path.join(directory, "missing.mp4"), 2)
  ).rejects.toThrow("Unable to prepare");
  const corrupt = path.join(directory, "corrupt.mp4");
  await writeFile(corrupt, "not a video");
  await expect(prepareVideoTail(corrupt, 2)).rejects.toThrow(
    "Unable to prepare"
  );
  expect(spawn).toHaveBeenCalledTimes(2);
});
