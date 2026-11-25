import { close, createReadStream, open, read } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryWorkSession } from "../libraryWorkSession";

import {
  ComfyClient,
  createProfileComfyClient,
  drainComfyProfile
} from "./ComfyClient";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

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
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.mocked(createReadStream).mockClear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const fixture = async (kind: "buffer" | "file") => {
  const root = await mkdtemp(path.join(tmpdir(), "mago-comfy-owned-"));
  roots.push(root);
  const work = new LibraryWorkSession(() => undefined);
  const monitor = {
    watch: vi.fn(),
    forget: vi.fn(),
    livePrompt: () => null,
    waitForSettle: vi.fn(),
    resetConnection: vi.fn()
  };
  const client = new ComfyClient("http://comfy.invalid", monitor, work.signal);
  const reference = { filename: "old.mp4" };
  const run = () =>
    work.run(() =>
      work.boundary(async () =>
        kind === "buffer"
          ? await client.downloadBuffer(reference, {
              maxBytes: 100,
              defaultType: "output"
            })
          : await client.downloadToFile(
              reference,
              path.join(root, "output.mp4"),
              { maxBytes: 100, defaultType: "output" }
            )
      )
    );
  return { root, work, client, monitor, run };
};

describe.each(["buffer", "file"] as const)(
  "Comfy %s transfer lifecycle",
  (kind) => {
    it("cancels and drains an abort-ignoring late response body", async () => {
      const f = await fixture(kind);
      const headers = deferred<Response>(),
        cleanup = deferred();
      const cancel = vi.fn(() => cleanup.promise);
      const fetcher = vi.fn(
        (_url: string, _init: RequestInit) => headers.promise
      );
      vi.stubGlobal("fetch", fetcher);
      const pending = f.run();
      const rejected = expect(pending).rejects.toThrow();
      let suspended = false;
      const suspension = f.work.suspend().then(() => {
        suspended = true;
      });
      headers.resolve(new Response(new ReadableStream({ cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await flush();
      expect(suspended).toBe(false);
      cleanup.resolve();
      await suspension;
      await rejected;
      expect(await readdir(f.root)).toEqual([]);
      expect(fetcher.mock.calls[0]![1].signal?.aborted).toBe(true);
    });

    it("drains active body cancellation before releasing temporary files", async () => {
      const f = await fixture(kind);
      const cleanup = deferred();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn(() => cleanup.promise);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  controller = c;
                },
                cancel
              })
            )
        )
      );
      const pending = f.run();
      const rejected = expect(pending).rejects.toThrow();
      await flush();
      controller.enqueue(new Uint8Array([1, 2]));
      await flush();
      let suspended = false;
      const suspension = f.work.suspend().then(() => {
        suspended = true;
      });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await flush();
      expect(suspended).toBe(false);
      cleanup.resolve();
      await suspension;
      await rejected;
      expect(await readdir(f.root)).toEqual([]);
    });

    it("cancels an oversized body instead of leaking the unused reader", async () => {
      const f = await fixture(kind);
      const cleanup = deferred();
      const cancel = vi.fn(() => cleanup.promise);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(new ReadableStream({ cancel }), {
              headers: { "content-length": "101" }
            })
        )
      );
      const pending = f.run();
      const rejected = expect(pending).rejects.toThrow("too large");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      let finished = false;
      pending.catch(() => {
        finished = true;
      });
      await flush();
      expect(finished).toBe(false);
      cleanup.resolve();
      await rejected;
      await f.work.suspend();
      expect(await readdir(f.root)).toEqual([]);
    });

    it("keeps successful local output retrieval available", async () => {
      const f = await fixture(kind);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("output bytes"))
      );
      const result = await f.run();
      if (kind === "buffer")
        expect(result).toEqual(Buffer.from("output bytes"));
      else
        expect(await readFile(path.join(f.root, "output.mp4"), "utf8")).toBe(
          "output bytes"
        );
      await f.work.suspend();
    });
  }
);

it("drains the real multipart source close even after fetch rejects and a sibling fails", async () => {
  const f = await fixture("file");
  const input = path.join(f.root, "input.png");
  await writeFile(input, Buffer.alloc(256 * 1024, 42));
  const profile = new AbortController();
  const client = createProfileComfyClient(
    "http://comfy.invalid",
    profile.signal
  );
  const closeStarted = deferred();
  const finishClose = deferred();
  const fetched = deferred();
  const actualCreate = vi.mocked(createReadStream).getMockImplementation()!;
  // Leave the hash pass real; hold the actual file descriptor's close in the upload pass.
  vi.mocked(createReadStream)
    .mockImplementationOnce(actualCreate)
    .mockImplementationOnce((file, options) =>
      actualCreate(file, {
        ...(typeof options === "object" ? options : {}),
        fs: {
          open,
          read,
          close(fd, cb) {
            closeStarted.resolve();
            void finishClose.promise.then(() => close(fd, cb));
          }
        }
      })
    );
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    const rejection = new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true }
      );
    });
    // Read header and file bytes, then stop pulling, as a rejected request can do.
    try {
      await reader.read();
      await reader.read();
      fetched.resolve();
    } finally {
      reader.releaseLock();
    }
    return rejection;
  });
  vi.stubGlobal("fetch", fetcher);
  const active = client.uploadFile(input);
  const rejected = expect(active).rejects.toMatchObject({ name: "AbortError" });
  await fetched.promise;
  await expect(
    Promise.all([active, client.uploadFile(path.join(f.root, "missing.png"))])
  ).rejects.toMatchObject({ code: "ENOENT" });
  profile.abort();
  await closeStarted.promise;
  let drained = false;
  const drain = drainComfyProfile(profile.signal).then(() => {
    drained = true;
  });
  try {
    await flush();
    expect(drained).toBe(false);
    await expect(client.uploadFile(input)).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    finishClose.resolve();
  }
  await drain;
  await rejected;
});

it("does not drain an abort-ignoring prompt POST but cancels its late body", async () => {
  const profile = new AbortController();
  const headers = deferred<Response>();
  const cancel = vi.fn();
  const fetcher = vi.fn(() => headers.promise);
  vi.stubGlobal("fetch", fetcher);
  const client = createProfileComfyClient(
    "http://comfy.invalid",
    profile.signal
  );
  const pending = client.submitGraph({});
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError"
  });
  expect(fetcher).toHaveBeenCalledOnce();
  profile.abort();
  await drainComfyProfile(profile.signal);
  await rejected;
  headers.resolve(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledOnce();
});

it("drains a locked /view response and leaves the previous local file intact", async () => {
  const f = await fixture("file");
  const destination = path.join(f.root, "output.mp4");
  await writeFile(destination, "existing output");
  const started = deferred();
  const cleanup = deferred();
  const cancel = vi.fn(() => cleanup.promise);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                started.resolve();
                controller.enqueue(new Uint8Array([1, 2, 3]));
                return new Promise(() => {});
              },
              cancel
            },
            { highWaterMark: 0 }
          )
        )
    )
  );
  const profile = new AbortController();
  const client = createProfileComfyClient(
    "http://comfy.invalid",
    profile.signal
  );
  const pending = client.downloadToFile(
    { filename: "fresh.mp4" },
    destination,
    { maxBytes: 100, defaultType: "output" }
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError"
  });
  await started.promise;
  profile.abort();
  let drained = false;
  const drain = drainComfyProfile(profile.signal).then(() => {
    drained = true;
  });
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(drained).toBe(false);
  } finally {
    cleanup.resolve();
  }
  await drain;
  await rejected;
  expect(await readFile(destination, "utf8")).toBe("existing output");
  expect(await readdir(f.root)).toEqual(["output.mp4"]);
});
