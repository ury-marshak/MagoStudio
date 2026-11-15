import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryWorkSession } from "../libraryWorkSession";

import { ComfyClient } from "./ComfyClient";

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
