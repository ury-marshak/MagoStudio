import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { extractVideoCaptionFrames } from "./videoFrames";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(async () => "/tmp/mock-caption-frames"),
  rm: vi.fn(),
  readdir: vi.fn(async () => ["frame.png"]),
  readFile: vi.fn(async () => Buffer.from("frame"))
}));
vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) }
}));

const child = () =>
  Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: vi.fn()
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawn).mockReset();
});

describe("caption frame cancellation", () => {
  it("does not create temporary files or spawn after a pre-start abort", async () => {
    await expect(
      extractVideoCaptionFrames({
        sourcePath: "test.mp4",
        totalFrames: 24,
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow();
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["first", "grid"])(
    "kills the %s extraction and waits for exit before cleanup",
    async (stage) => {
      const first = child();
      const second = child();
      vi.mocked(spawn)
        .mockReturnValueOnce(first as never)
        .mockReturnValueOnce(second as never);
      const controller = new AbortController();
      const result = extractVideoCaptionFrames({
        sourcePath: "test.mp4",
        totalFrames: 24,
        signal: controller.signal
      });
      const rejected = expect(result).rejects.toThrow("cancelled frames");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      if (stage === "grid") {
        first.emit("close", 0);
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      }
      const active = stage === "first" ? first : second;
      controller.abort(new Error("cancelled frames"));
      expect(active.kill).toHaveBeenCalledWith("SIGKILL");
      expect(rm).not.toHaveBeenCalled();
      active.emit("close", null);
      await rejected;
      expect(rm).toHaveBeenCalledWith("/tmp/mock-caption-frames", {
        recursive: true,
        force: true
      });
      expect(spawn).toHaveBeenCalledTimes(stage === "first" ? 1 : 2);
    }
  );
});
