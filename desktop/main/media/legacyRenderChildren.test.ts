import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { probeRenderedVideoMetadata } from "../cloud/probeRenderedVideoMetadata";
import { LibraryWorkSession } from "../libraryWorkSession";

import { doesVideoHaveAudioStream } from "./doesVideoHaveAudioStream";
import { runLibraryFfmpeg } from "./runLibraryFfmpeg";
import { validateVideo } from "./validateVideo";

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const operations = [
  [
    "render encode/thumbnail",
    (signal: AbortSignal) =>
      runLibraryFfmpeg("ffmpeg", ["-i", "old.mp4"], signal, "fixture error")
  ],
  [
    "interrupted-video validation",
    (signal: AbortSignal) => validateVideo("old.mp4", signal)
  ],
  [
    "render metadata probe",
    (signal: AbortSignal) => probeRenderedVideoMetadata("old.mp4", signal)
  ],
  [
    "render audio probe",
    (signal: AbortSignal) => doesVideoHaveAudioStream("old.mp4", signal)
  ]
] as const;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(operations)("%s local child ownership", (_name, operation) => {
  it("kills locally on library teardown and drains exit, late output and stdio through close", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    });
    mocks.spawn.mockReturnValue(child);
    const work = new LibraryWorkSession(() => undefined);
    const pending = work.run(() =>
      work.boundary(async () => await operation(work.signal))
    );
    const rejected = expect(pending).rejects.toThrow();
    let suspended = false;
    const suspension = work.suspend().then(() => {
      suspended = true;
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", 0);
    child.stdout.write("# late framecrc\n0, 0, 0\n");
    child.stderr.write("Input #0, late\nStream #0:0: Audio: aac\n");
    await flush();
    expect(suspended).toBe(false);
    child.emit("close", 0);
    await suspension;
    await rejected;
    work.reset();
  });

  it("does not release timeout cleanup before close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    });
    mocks.spawn.mockReturnValue(child);
    const work = new LibraryWorkSession(() => undefined);
    let finished = false;
    const pending = work
      .run(() => work.boundary(async () => await operation(work.signal)))
      .finally(() => {
        finished = true;
      });
    const observed = pending.catch(() => null);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(finished).toBe(false);
    const suspension = work.suspend();
    child.emit("close", 0);
    await observed;
    await suspension;
  });

  it("keeps spawn/abort errors owned until close", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    });
    mocks.spawn.mockReturnValue(child);
    const work = new LibraryWorkSession(() => undefined);
    const pending = work.run(() =>
      work.boundary(async () => await operation(work.signal))
    );
    const observed = pending.catch(() => null);
    child.emit("error", new Error("spawn/abort error"));
    let suspended = false;
    const suspension = work.suspend().then(() => {
      suspended = true;
    });
    await flush();
    expect(suspended).toBe(false);
    child.emit("close", -1);
    await observed;
    await suspension;
  });

  it("cannot spawn with an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await Promise.resolve()
      .then(async () => {
        await operation(controller.signal);
      })
      .catch(() => {});
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
