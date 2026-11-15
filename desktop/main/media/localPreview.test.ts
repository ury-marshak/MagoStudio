import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import { expect, it } from "vitest";

import type { ProjectRepository } from "../database/projectRepository";

import { createImageThumbnail } from "./imageThumbnail";
import { VideoFrameService } from "./videoFrameService";

it("keeps frame, filmstrip and thumbnail decoding available with bundled FFmpeg only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mago-local-preview-"));
  const video = path.join(root, "fixture.mp4");
  const poster = path.join(root, "poster.jpg");
  const service = new VideoFrameService({
    resolveMediaPath: async () => video,
    getAsset: async () => ({ data: { size: [160, 90], total_frames: 48 } })
  } as unknown as ProjectRepository);
  try {
    if (!ffmpegPath) throw new Error("Bundled FFmpeg is unavailable");
    await promisify(execFile)(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=24:d=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video
    ]);
    const frame = await service.extractFrame({
      assetId: "fixture",
      frameNumber: 24,
      fps: 24
    });
    const strip = await service.generateFilmstrip({
      assetId: "fixture",
      width: 320,
      frameHeight: 45
    });
    for (const image of [frame, strip]) {
      expect(image).toMatch(/^data:image\/jpeg;base64,/);
      expect(
        Buffer.from(image.split(",")[1]!, "base64").subarray(0, 2)
      ).toEqual(Buffer.from([0xff, 0xd8]));
    }
    await createImageThumbnail(video, poster, service.libraryWork.signal);
    expect((await readFile(poster)).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8])
    );
  } finally {
    await service.libraryWork.suspend();
    await rm(root, { recursive: true, force: true });
  }
});
