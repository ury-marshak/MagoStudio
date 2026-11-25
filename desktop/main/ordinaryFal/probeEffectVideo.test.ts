import { ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import { afterEach, expect, it, vi } from "vitest";

import {
  createEffectVideoPacketParser,
  type EffectVideoMetadata,
  probeEffectVideo,
  validateEffectVideo
} from "./probeEffectVideo";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const run = promisify(execFile);
const directories: string[] = [];
const fixturePath = async (name: string) => {
  const directory = await mkdtemp(join(tmpdir(), "mago-effect-video-"));
  directories.push(directory);
  return join(directory, name);
};
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

it("streams VFR packet timing in presentation rather than decode order", () => {
  const parser = createEffectVideoPacketParser();
  const output = [
    "#tb 0: 2/1000",
    "#dimensions 0: 1920x1080",
    "#media_type 1: audio",
    "0, -1100, -900, 100, 12, 0x0, F=0x4", // Discarded preroll.
    "0, -1000, -500, 500, 12, 0x0",
    "1,  4000, 4000, 100, 12, 0x0", // Audio must not extend video duration.
    "0,  -500, 1000, 500, 12, 0x0", // Last in presentation order.
    "0,     0,    0, 200, 12, 0x0"
  ].join("\r\n");
  for (let offset = 0; offset < output.length; offset += 7)
    parser.read(output.slice(offset, offset + 7));
  expect(parser.finish()).toMatchObject({
    durationSeconds: 4,
    width: 1920,
    height: 1080,
    fps: 0.75,
    hasAudio: true
  });
  const shifted = createEffectVideoPacketParser();
  shifted.read(
    [
      "#tb 0: 1/1000",
      "#dimensions 0: 1920x1080",
      "0, 0,    0, 1000, 12, 0x0",
      "0, 1, 1000,  400, 12, 0x0",
      "0, 2, 3000, 1000, 12, 0x0"
    ].join("\n")
  );
  const { presentationSignature } = parser.finish();
  expect(presentationSignature).toMatch(/^pts-us-v1:[a-f0-9]{64}$/);
  expect(shifted.finish().presentationSignature).toBe(presentationSignature);
});

it("distinguishes VFR from CFR at the same packet count and presentation duration", () => {
  const inspect = (starts: number[]) => {
    const parser = createEffectVideoPacketParser();
    parser.read(
      [
        "#tb 0: 1/48",
        "#dimensions 0: 1920x1080",
        ...starts.map(
          (pts, i) =>
            `0, ${pts}, ${pts}, ${(starts[i + 1] ?? 8) - pts}, 12, 0x0`
        )
      ].join("\n")
    );
    return parser.finish();
  };
  const cfr = inspect([0, 2, 4, 6]);
  const vfr = inspect([0, 1, 4, 7]);
  for (const metadata of [cfr, vfr])
    expect(metadata).toMatchObject({ durationSeconds: 8 / 48, fps: 24 });
  expect(vfr.presentationSignature).not.toBe(cfr.presentationSignature);
});

it("does not guess a duration when packet timestamps are missing", () => {
  const parser = createEffectVideoPacketParser();
  expect(() => parser.read("0, 0, NOPTS, 512, 12, 0x0\n")).toThrow(
    "Select a readable local MP4 or MOV video"
  );
});

const validSource: EffectVideoMetadata = {
  durationSeconds: 3,
  width: 720,
  height: 2160,
  fps: 24,
  hasAudio: false,
  presentationSignature: `pts-us-v1:${"a".repeat(64)}`,
  sizeBytes: 200_000_000
};

it("accepts Kling's inclusive limits on duration, both axes, fps and bytes", () => {
  expect(() => validateEffectVideo(validSource, "video-edit")).not.toThrow();
  expect(() =>
    validateEffectVideo(
      {
        ...validSource,
        durationSeconds: 10,
        width: 2160,
        height: 720,
        fps: 60
      },
      "video-edit"
    )
  ).not.toThrow();
});

it.each([
  [{ durationSeconds: 2.999 }, /3 and 10 seconds/],
  [{ durationSeconds: 10.001 }, /3 and 10 seconds/],
  [{ width: 719 }, /dimensions/],
  [{ height: 2161 }, /dimensions/],
  [{ fps: 23.999 }, /24 and 60 fps/],
  [{ fps: 60.001 }, /24 and 60 fps/],
  [{ sizeBytes: 200_000_001 }, /200 MB/],
  [{ durationSeconds: NaN }, /readable local/]
] as const)(
  "rejects Kling source outside its limits: %j",
  (override, message) => {
    expect(() =>
      validateEffectVideo({ ...validSource, ...override }, "video-edit")
    ).toThrow(message);
  }
);

it("enforces the app's initial Topaz source cap in either orientation", () => {
  const landscape = {
    ...validSource,
    durationSeconds: 10,
    width: 1920,
    height: 1080
  };
  const portrait = { ...landscape, width: 1080, height: 1920 };
  for (const source of [landscape, portrait])
    expect(() => validateEffectVideo(source, "video-upscale")).not.toThrow();
  for (const source of [
    { ...landscape, width: 1921 },
    { ...portrait, width: 1081 },
    { ...portrait, durationSeconds: 10.001 }
  ])
    expect(() => validateEffectVideo(source, "video-upscale")).toThrow(/1080p/);
  expect(() =>
    validateEffectVideo(
      { ...portrait, sizeBytes: 200_000_001 },
      "video-upscale"
    )
  ).toThrow(/200 MB/);
});

it.skipIf(!ffmpegPath).each(["mp4", "mov"])(
  "probes a local %s using video timing even with a longer audio stream",
  async (format) => {
    const file = await fixturePath(`fixture.${format}`);
    await run(ffmpegPath!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=s=720x722:r=30:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=d=4",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      file
    ]);
    const metadata = await probeEffectVideo(file);
    expect(metadata).toMatchObject({
      durationSeconds: 3,
      width: 720,
      height: 722,
      fps: 30,
      hasAudio: true,
      sizeBytes: (await stat(file)).size
    });
    expect(() => validateEffectVideo(metadata, "video-edit")).not.toThrow();
  }
);

it.skipIf(!ffmpegPath)(
  "probes actual VFR packets in a silent MP4",
  async () => {
    const file = await fixturePath("vfr.mp4");
    await run(ffmpegPath!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=s=160x120:r=30:d=3",
      "-vf",
      "select='lt(n,30)+gte(n,30)*not(mod(n,3))'",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      file
    ]);
    const metadata = await probeEffectVideo(file);
    // Keep frames 0–29, then every third up to 87. The last sample ends at 88/30.
    expect(metadata.durationSeconds).toBeCloseTo(88 / 30);
    expect(metadata.fps).toBeCloseTo(50 / (88 / 30));
    expect(metadata.hasAudio).toBe(false);
  }
);

it.skipIf(!ffmpegPath)(
  "accepts a legacy MOV without a file type atom",
  async () => {
    const file = await fixturePath("legacy.mov");
    await run(ffmpegPath!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=s=160x120:d=1",
      "-c:v",
      "libx264",
      file
    ]);
    const bytes = await readFile(file);
    expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
    bytes.write("free", 4, "ascii");
    await writeFile(file, bytes);
    await expect(probeEffectVideo(file)).resolves.toMatchObject({
      durationSeconds: 1
    });
  }
);

it.skipIf(!ffmpegPath).each(["matroska", "3gp"])(
  "rejects actual %s container even with a .mp4 name",
  async (format) => {
    const file = await fixturePath("fixture.mp4");
    await run(ffmpegPath!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=s=176x144:d=0.2",
      "-c:v",
      "mpeg4",
      "-f",
      format,
      file
    ]);
    await expect(probeEffectVideo(file)).rejects.toThrow(
      "Select a readable local MP4 or MOV video"
    );
  }
);

it.skipIf(!ffmpegPath)(
  "rejects an unsupported major brand even with MP4-compatible brands",
  async () => {
    const file = await fixturePath("fixture.mp4");
    await run(ffmpegPath!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=s=176x144:d=0.2",
      "-c:v",
      "libx264",
      "-brand",
      "zzzz",
      file
    ]);
    await expect(probeEffectVideo(file)).rejects.toThrow(
      /readable local MP4 or MOV/
    );
  }
);

it("does not expose file paths on errors", async () => {
  const missingPath = await fixturePath("private-asset.mp4");
  await expect(probeEffectVideo(missingPath)).rejects.toThrow(
    /^Select a readable local MP4 or MOV video$/
  );
});

it("rejects an already-cancelled probe with a safe abort error", async () => {
  const signal = AbortSignal.abort(new Error("private abort reason"));
  await expect(probeEffectVideo("unused.mp4", signal)).rejects.toMatchObject({
    name: "AbortError",
    message: "Video inspection was cancelled"
  });
});

it.skipIf(!ffmpegPath).each(["abort", "error"] as const)(
  "waits for close after child %s",
  async (event) => {
    const file = await fixturePath("fixture.mp4");
    await writeFile(
      file,
      Buffer.from("000000106674797069736f6d00000000", "hex")
    );
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    vi.mocked(spawn).mockReturnValueOnce(child);
    const controller = new AbortController();
    const probe = probeEffectVideo(file, controller.signal);
    const settled = vi.fn();
    const result = probe.then(settled, settled);
    await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
    if (event === "abort") {
      controller.abort(new Error("private abort reason"));
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("exit", null, "SIGKILL");
    } else {
      child.emit("error", new Error("private spawn details"));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null, null);
    await result;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining(
        event === "abort"
          ? { name: "AbortError", message: "Video inspection was cancelled" }
          : { message: "Select a readable local MP4 or MOV video" }
      )
    );
  }
);
