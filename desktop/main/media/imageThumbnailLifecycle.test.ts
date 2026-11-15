import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createImageThumbnail } from "./imageThumbnail";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  mocks.spawn.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mago-thumbnail-close-"));
  roots.push(root);
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    kill: vi.fn()
  });
  mocks.spawn.mockReturnValueOnce(child);
  const signal = new AbortController();
  const output = path.join(root, "output.jpg");
  const source = path.join(root, "input.png");
  await writeFile(source, "fixture input");
  const result = createImageThumbnail(source, output, signal.signal);
  // Rejection is observed immediately, even when deliberately delaying close.
  const outcome = result.then(
    () => null,
    (error: unknown) => error
  );
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  const temporary = mocks.spawn.mock.calls[0]![1].at(-1) as string;
  return { root, child, signal, output, temporary, result, outcome };
};

describe("thumbnail child cleanup", () => {
  it("kills on abort, waits for close, then removes even late-written temporary bytes", async () => {
    const test = await fixture();
    test.signal.abort();
    expect(test.child.kill).toHaveBeenCalledWith("SIGKILL");
    let finished = false;
    void test.outcome.then(() => {
      finished = true;
    });
    await writeFile(test.temporary, "late thumbnail bytes");
    expect(finished).toBe(false);
    test.child.emit("close", 0);
    expect(await test.outcome).toBe(test.signal.signal.reason);
    expect(await readdir(test.root)).toEqual(["input.png"]);
  });

  it("waits for close after a spawn error rather than releasing temporary ownership early", async () => {
    const test = await fixture();
    const failure = new Error("fixture spawn error");
    test.child.emit("error", failure);
    let finished = false;
    void test.outcome.then(() => {
      finished = true;
    });
    await writeFile(test.temporary, "late bytes");
    expect(finished).toBe(false);
    test.child.emit("close", -1);
    expect(await test.outcome).toBe(failure);
    expect(await readdir(test.root)).toEqual(["input.png"]);
  });

  it("still publishes a successful local thumbnail", async () => {
    const test = await fixture();
    await writeFile(test.temporary, "valid fixture jpeg");
    test.child.emit("close", 0);
    expect(await test.outcome).toBeNull();
    expect(await readdir(test.root)).toEqual(["input.png", "output.jpg"]);
    expect(test.child.kill).not.toHaveBeenCalled();
  });

  it("does not spawn when already cancelled", async () => {
    const signal = new AbortController();
    signal.abort();
    await expect(
      createImageThumbnail("input.png", "output.jpg", signal.signal)
    ).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
