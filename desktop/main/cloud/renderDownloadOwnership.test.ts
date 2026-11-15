import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

import { LibraryWorkSession } from "../libraryWorkSession";

import { downloadRenderOutput } from "./downloadRenderOutput";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const roots: string[] = [];
const owners: LibraryWorkSession<undefined>[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.suspend()));
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const fixture = async (
  fetchFromCloudStorage: (url: URL, init: RequestInit) => Promise<Response>
) => {
  const root = await mkdtemp(path.join(tmpdir(), "mago-render-stream-"));
  roots.push(root);
  const work = new LibraryWorkSession(() => undefined);
  owners.push(work);
  const progress = vi.fn();
  const run = () =>
    work.run(() =>
      work.boundary(() =>
        downloadRenderOutput({
          url: "https://storage.invalid/output.mp4",
          libraryRoot: root,
          jobId: "reused",
          signal: work.signal,
          cloudStorage: {
            allowedHosts: ["storage.invalid"],
            fetchFromCloudStorage
          },
          onProgress: progress
        })
      )
    );
  return {
    root,
    work,
    progress,
    run,
    output: path.join(root, "renders/cloud/reused/output.mp4")
  };
};

describe("library-owned cloud render download bodies", () => {
  it("refuses work during suspension before any transport or file dispatch", async () => {
    const fetcher = vi.fn();
    const f = await fixture(fetcher);
    await f.work.suspend();
    await expect(f.run()).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });

  it("drains cancellation of an abort-ignoring late response before replacement", async () => {
    const headers = deferred<Response>(),
      cleanup = deferred();
    const cancel = vi.fn(() => cleanup.promise);
    const fetcher = vi.fn(() => headers.promise);
    const f = await fixture(fetcher);
    const pending = f.run();
    const rejected = expect(pending).rejects.toThrow();
    await flush();
    let suspended = false;
    const suspension = f.work.suspend().then(() => {
      suspended = true;
    });
    headers.resolve(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-length": "100" }
      })
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await flush();
    expect(suspended).toBe(false);
    expect(f.progress).not.toHaveBeenCalled();
    cleanup.resolve();
    await suspension;
    await rejected;
    expect(await readdir(f.root)).toEqual([]);
  });

  it("waits for active body cancellation cleanup, not merely the pipeline rejection", async () => {
    const cleanup = deferred();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => cleanup.promise);
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
            cancel
          }),
          { headers: { "content-length": "100" } }
        )
    );
    const f = await fixture(fetcher);
    const pending = f.run();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.enqueue(new Uint8Array([1, 2]));
    await vi.waitFor(() => expect(f.progress).toHaveBeenCalled());
    let suspended = false;
    const suspension = f.work.suspend().then(() => {
      suspended = true;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await flush();
    expect(suspended).toBe(false);
    const progressCount = f.progress.mock.calls.length;
    cleanup.resolve();
    await suspension;
    await rejected;
    expect(f.progress).toHaveBeenCalledTimes(progressCount);
    await expect(readFile(f.output)).rejects.toThrow();
    expect(await readdir(path.dirname(f.output))).toEqual([]);
  });

  it("coalesces observers only within the originating lifetime and starts clean after a drained reset", async () => {
    const response = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue(new Response("replacement"));
    const f = await fixture(fetcher);
    const first = f.run(),
      second = f.run();
    const firstRejected = expect(first).rejects.toThrow(),
      secondRejected = expect(second).rejects.toThrow();
    await flush();
    expect(fetcher).toHaveBeenCalledOnce();
    const suspension = f.work.suspend();
    response.resolve(new Response("old bytes"));
    await suspension;
    await Promise.all([firstRejected, secondRejected]);
    f.work.reset();
    await f.run();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await readFile(f.output, "utf8")).toBe("replacement");
  });

  it("drains a delayed filesystem stat and does not publish after teardown", async () => {
    const f = await fixture(async () => new Response("original"));
    const gate = deferred<Awaited<ReturnType<typeof stat>>>();
    const entered = deferred();
    vi.mocked(stat).mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const pending = f.run();
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    let suspended = false;
    const suspension = f.work.suspend().then(() => {
      suspended = true;
    });
    await flush();
    expect(suspended).toBe(false);
    gate.resolve({ size: 8 } as Awaited<ReturnType<typeof stat>>);
    await suspension;
    await rejected;
    await expect(readFile(f.output)).rejects.toThrow();
    expect(await readdir(path.dirname(f.output))).toEqual([]);
  });

  it("keeps ordinary authorized downloads and independent image extensions working", async () => {
    const f = await fixture(async () => new Response("local cached bytes"));
    await f.run();
    expect(await readFile(f.output, "utf8")).toBe("local cached bytes");
    await f.work.suspend();
    expect(await readFile(f.output, "utf8")).toBe("local cached bytes");
  });
});
