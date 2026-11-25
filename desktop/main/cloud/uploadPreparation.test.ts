import { EventEmitter } from "node:events";
import {
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ProfileIoDrain } from "../providers/profileIoDrain";

import { UploadService } from "./uploadService";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("ffmpeg-static", () => ({ default: "ffmpeg" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) };
});

const deferred = () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, pending };
};

let libraryRoot: string;
let sourcePath: string;
let profile: AbortController;
let tracker: ProfileIoDrain;
let uploads: UploadService;

beforeEach(async () => {
  spawn.mockReset();
  libraryRoot = await mkdtemp(path.join(tmpdir(), "mago-upload-preparation-"));
  sourcePath = path.join(libraryRoot, "source");
  await writeFile(sourcePath, "source fixture");
  profile = new AbortController();
  tracker = new ProfileIoDrain();
  uploads = new UploadService(async () => libraryRoot, tracker);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await rm(libraryRoot, { recursive: true, force: true });
});

const holdEncoder = () => {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: vi.fn()
  });
  spawn.mockReturnValueOnce(child);
  const temporary = async () => {
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    return spawn.mock.calls[0]![1].at(-1) as string;
  };
  return { child, temporary };
};

const videoInput = () => ({ assetId: "asset", sourcePath, force: true });

it("checks the original profile when a queued video writer gets its turn", async () => {
  const encoder = holdEncoder();
  const local = uploads.prepare(videoInput());
  const temporary = await encoder.temporary();
  const queue = uploads.libraryWork.state.preparations;
  const [destination, predecessor] = [...queue.entries()][0]!;
  const retired = uploads.prepare({ ...videoInput(), profile: profile.signal });
  const outcome = expect(retired).rejects.toMatchObject({ name: "AbortError" });
  try {
    // Let the root lookup finish and the writer join the queue.
    await vi.waitFor(() =>
      expect(queue.get(destination)).not.toBe(predecessor)
    );
    profile.abort();
    // The local predecessor and the unstarted writer don't hold the drain.
    const drained = vi.fn();
    void tracker.drainRetired().then(drained);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toHaveBeenCalledOnce();
    await writeFile(temporary, "encoded fixture");
  } finally {
    encoder.child.emit("close", 0);
    await Promise.allSettled([local, outcome]);
  }
  await expect(local).resolves.toMatchObject({ encoded: true });
  await outcome;
  expect(spawn).toHaveBeenCalledOnce();
});

it.each(["video", "image"] as const)(
  "aborts a retired %s encoder and drains close and partial-file cleanup",
  async (kind) => {
    const encoder = holdEncoder();
    const input = { ...videoInput(), profile: profile.signal };
    const preparation =
      kind === "video"
        ? uploads.prepare(input)
        : uploads.prepareImage({ ...input, libraryRoot, extension: "webp" });
    const outcome = expect(preparation).rejects.toMatchObject({
      name: "AbortError"
    });
    const temporary = await encoder.temporary();
    await writeFile(temporary, "partial fixture");
    profile.abort();
    const drained = vi.fn();
    const drain = tracker.drainRetired().then(drained);
    try {
      encoder.child.emit("exit", null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(encoder.child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(drained).not.toHaveBeenCalled();
      expect(await readdir(path.dirname(temporary))).toEqual([
        path.basename(temporary)
      ]);
    } finally {
      encoder.child.emit("close", null);
      await drain;
    }
    await outcome;
    expect(await readdir(path.dirname(temporary))).toEqual([]);
  }
);

it("drains an issued fsync/close without publishing after profile retirement", async () => {
  const syncing = deferred();
  const finishSync = deferred();
  const close = vi.fn(async () => {});
  vi.mocked(open).mockResolvedValueOnce({
    sync: async () => {
      syncing.release();
      await finishSync.pending;
    },
    close
  } as unknown as Awaited<ReturnType<typeof open>>);
  const encoder = holdEncoder();
  const preparation = uploads.prepare({
    ...videoInput(),
    profile: profile.signal
  });
  const outcome = expect(preparation).rejects.toMatchObject({
    name: "AbortError"
  });
  const temporary = await encoder.temporary();
  await writeFile(temporary, "encoded fixture");
  encoder.child.emit("close", 0);
  await syncing.pending;

  profile.abort();
  const drained = vi.fn();
  const drain = tracker.drainRetired().then(drained);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  } finally {
    finishSync.release();
    await drain;
  }
  expect(close).toHaveBeenCalledOnce();
  await outcome;
  expect(rename).not.toHaveBeenCalled();
  expect(await readdir(path.dirname(temporary))).toEqual([]);
});
