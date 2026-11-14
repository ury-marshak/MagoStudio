import { execFile, spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import {
  extractKeyframeGrid,
  extractLastFrame,
  extractMetricsFrameGrid
} from "./localScriptMedia";

// Observe real, local FFmpeg children without replacing their abort behavior.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const runFfmpeg = async (args: string[]): Promise<Buffer> => {
  const { stdout } = await promisify(execFile)(
    ffmpegPath!,
    ["-hide_banner", "-loglevel", "error", ...args],
    {
      windowsHide: true,
      timeout: 10000,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024
    }
  );
  return stdout;
};

let directory: string;
let filename: string;
let shortFilename: string;
let longerAudioFilename: string;
let lowFpsFilename: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mago-media-test-"));
  filename = path.join(directory, "shot.mp4");
  shortFilename = path.join(directory, "single-frame.mp4");
  for (const [output, frames] of [
    [filename, 120],
    [shortFilename, 1]
  ] as const) {
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x32:rate=24",
      "-frames:v",
      String(frames),
      "-c:v",
      "libx264",
      output
    ]);
  }
  longerAudioFilename = path.join(directory, "video-1s-audio-3s.mp4");
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x32:rate=24:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=3",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    longerAudioFilename
  ]);
  lowFpsFilename = path.join(directory, "low-fps.mp4");
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x32:rate=0.5:duration=6",
    "-c:v",
    "libx264",
    lowFpsFilename
  ]);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(spawn).mockClear();
});

const dimensions = (png: Buffer): number[] => {
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

const decodedFrame = (input: string, frame: number): Promise<Buffer> =>
  runFfmpeg([
    "-i",
    input,
    "-map",
    "0:v:0",
    "-vf",
    `select=eq(n\\,${frame})`,
    "-frames:v",
    "1",
    "-c:v",
    "png",
    "-f",
    "image2pipe",
    "pipe:1"
  ]);

it("extracts both a full metrics grid and the final-frame partial grid with bundled FFmpeg", async () => {
  for (const timestamps of [[0, 1.25, 2.5, 3.75], [5]]) {
    const png = await extractMetricsFrameGrid(filename, timestamps, 5);
    expect(dimensions(png)).toEqual([1024, 1024]);
  }
});

it("returns the final decoded frame, not the first frame near EOF", async () => {
  const controller = new AbortController();
  const actual = await extractLastFrame(filename, controller.signal);
  const expected = await decodedFrame(filename, 119);
  expect(actual.equals(expected)).toBe(true);
  expect(actual.equals(await decodedFrame(filename, 116))).toBe(false);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("extracts the final frame even when a valid clip is shorter than the tail seek", async () => {
  const actual = await extractLastFrame(shortFilename);
  expect(actual.equals(await decodedFrame(shortFilename, 0))).toBe(true);
});

it.each([
  {
    name: "1s video with 3s audio",
    input: () => longerAudioFilename,
    last: 23
  },
  { name: "0.5fps video lasting 6s", input: () => lowFpsFilename, last: 2 }
])(
  "falls back to a single selected final frame for $name",
  async ({ input, last }) => {
    const controller = new AbortController();
    const actual = await extractLastFrame(input(), controller.signal);
    const expected = await decodedFrame(input(), last);
    expect(dimensions(actual)).toEqual([64, 32]);
    expect(actual.equals(expected)).toBe(true);
    expect(actual.equals(await decodedFrame(input(), 0))).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(3);
    const args = vi.mocked(spawn).mock.calls.map((call) => call[1] as string[]);
    expect(args[0]).toContain("-sseof");
    expect(args[0]).toContain("reverse");
    expect(args[1]).toContain("framecrc");
    expect(args[2]).toContain(`select=eq(n\\,${last})`);
    expect(args[2]).not.toContain("reverse");
    expect(args[2].slice(args[2].indexOf("-frames:v"), -1)).toEqual([
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2pipe"
    ]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
);

it.each([1, 4])(
  "extracts a %i-keyframe grid with the selected dimensions",
  async (count) => {
    const controller = new AbortController();
    const png = await extractKeyframeGrid(
      filename,
      5,
      count,
      controller.signal
    );
    expect(dimensions(png)).toEqual([512 * count + 4 * (count - 1), 256]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
);

it.each([1, 4])(
  "extracts a %i-keyframe grid from a single-frame clip",
  async (count) => {
    const png = await extractKeyframeGrid(shortFilename, 1 / 24, count);
    expect(dimensions(png)).toEqual([512 * count + 4 * (count - 1), 256]);
  }
);

const cancellableExtractions = [
  {
    name: "last frame",
    extract: (input: string, signal: AbortSignal) =>
      extractLastFrame(input, signal)
  },
  {
    name: "keyframe grid",
    extract: (input: string, signal: AbortSignal) =>
      extractKeyframeGrid(input, 5, 4, signal)
  }
];

it.each(cancellableExtractions)(
  "rejects a pre-aborted $name without spawning",
  async ({ extract }) => {
    const controller = new AbortController();
    controller.abort();
    await expect(extract(filename, controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
);

it.each(cancellableExtractions)(
  "kills an in-flight $name and rejects promptly",
  async ({ extract }) => {
    const controller = new AbortController();
    const pending = extract(filename, controller.signal);
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<
      typeof spawn
    >;
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve())
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    // Spawn has returned but FFmpeg cannot have exited before this synchronous abort.
    controller.abort();
    await rejected;
    expect(child.killed).toBe(true);
    await closed;
    expect(child.signalCode).toBe("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
);

it.each([
  { name: "metadata probe", stage: 2 },
  { name: "selected-frame decode", stage: 3 }
])(
  "cancels the fallback $name and cleans up its listener",
  async ({ stage }) => {
    const actual =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process"
      );
    const controller = new AbortController();
    let child!: ReturnType<typeof spawn>;
    let closed!: Promise<void>;
    for (let index = 1; index < stage; index += 1) {
      vi.mocked(spawn).mockImplementationOnce(actual.spawn);
    }
    vi.mocked(spawn).mockImplementationOnce(((
      ...args: Parameters<typeof spawn>
    ) => {
      child = actual.spawn(...args);
      closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      );
      child.once("spawn", () => controller.abort());
      return child;
    }) as typeof spawn);
    await expect(
      extractLastFrame(longerAudioFilename, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    await closed;
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(stage);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
);

it("removes the abort listener when FFmpeg fails", async () => {
  const controller = new AbortController();
  await expect(
    extractLastFrame(path.join(directory, "missing.mp4"), controller.signal)
  ).rejects.toThrow("Unable to extract continuity image");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});
