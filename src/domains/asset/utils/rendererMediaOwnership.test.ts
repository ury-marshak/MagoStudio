import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  root: "/library-a",
  mode: "cloud",
  get: vi.fn(),
  set: vi.fn(),
  supported: vi.fn(),
  clear: vi.fn(),
  quota: vi.fn(),
  watch: vi.fn(),
  readLibrary: vi.fn(),
  blobs: new Map<string, Blob>()
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => ({
    account: { mode: fixture.mode },
    library: {
      get: fixture.readLibrary,
      onWillChange: fixture.watch,
      onDidChange: vi.fn()
    }
  })
}));
vi.mock("./opfs", () => ({
  isOPFSSupported: fixture.supported,
  opfsGet: fixture.get,
  opfsSet: fixture.set,
  opfsClear: fixture.clear
}));
vi.mock("./opfs/quotaManagement", () => ({
  isQuotaExceededError: (error: Error) => error.name === "QuotaExceededError",
  handleQuotaExceeded: fixture.quota
}));
vi.mock("@app/services/mediaBunny", () => ({ extractFrameFromVideo: vi.fn() }));

import { extractFrameFromVideo } from "@app/services/mediaBunny";

import {
  rendererLibrary,
  RendererLibrarySession
} from "@/platform/rendererLibraryWork";

import { cacheImageUrl } from "./cacheImageUrl";
import { cacheGet, cacheSet } from "./cacheStorage";
import { cacheVideoUrl } from "./cacheVideoUrl";
import { downloadVideoInChunks } from "./downloadVideoInChunks";
import { getFilmstripFromCache, saveFilmstripToCache } from "./filmstripCache";
import { getFrameFromCache, saveFrameToCache } from "./frameCache";
import { MediaDownloadScheduler } from "./mediaDownloadScheduler";
import { resolveCachedVideoPreview } from "./resolveCachedVideoPreview";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const fetchMock = vi.fn();
const blob = new Blob(["cached bytes"]);
const aborts = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: "AbortError" });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.root = "/library-a";
  fixture.mode = "cloud";
  fixture.blobs.clear();
  fixture.watch.mockResolvedValue(undefined);
  fixture.readLibrary.mockImplementation(async () => ({
    rootPath: fixture.root
  }));
  fixture.supported.mockResolvedValue(true);
  fixture.get.mockImplementation(async (type, key) =>
    fixture.blobs.get(`${type}:${key}`)
  );
  fixture.set.mockImplementation(async (type, key, value) => {
    fixture.blobs.set(`${type}:${key}`, value);
  });
  fixture.quota.mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue(new Response("fresh bytes"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {
    location: { href: "https://mago.local/", origin: "https://mago.local" }
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
});
afterEach(async () => {
  await rendererLibrary.suspend();
  rendererLibrary.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("renderer media library ownership", () => {
  it("does not dispatch a cache miss after a delayed support lookup outlives its library", async () => {
    const support = deferred<boolean>();
    fixture.supported.mockReturnValueOnce(support.promise);
    const request = cacheImageUrl("https://cdn.invalid/image", "reused");
    const rejected = aborts(request);
    await rendererLibrary.suspend();
    rendererLibrary.reset();
    support.resolve(true);
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it.each([cacheImageUrl, cacheVideoUrl])(
    "suppresses late cache hits and direct-URL error fallbacks (%#)",
    async (read) => {
      const cached = deferred<Blob>();
      fixture.get.mockReturnValueOnce(cached.promise);
      const request = read("https://cdn.invalid/media", "reused");
      const rejected = aborts(request);
      await vi.waitFor(() => expect(fixture.get).toHaveBeenCalled());
      let drained = false;
      const suspension = rendererLibrary.suspend().then(() => {
        drained = true;
      });
      await flush();
      expect(drained).toBe(false);
      cached.resolve(blob);
      await suspension;
      rendererLibrary.reset();
      await rejected;
      expect(fetchMock).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    }
  );

  it("drains a complete issued cache write and namespaces reused IDs without deleting local bytes", async () => {
    const written = deferred<void>();
    fixture.set.mockImplementationOnce(async (type, key, value) => {
      await written.promise;
      fixture.blobs.set(`${type}:${key}`, value);
    });
    const request = cacheSet("image", "reused", blob);
    const rejected = aborts(request);
    await vi.waitFor(() => expect(fixture.set).toHaveBeenCalled());
    const oldKey = fixture.set.mock.calls[0][1];
    let drained = false;
    const suspension = rendererLibrary.suspend().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    written.resolve();
    await suspension;
    await rejected;
    fixture.root = "/library-b";
    rendererLibrary.reset();
    expect(await cacheGet("image", "reused")).toBeUndefined();
    await cacheSet("image", "reused", new Blob(["replacement"]));
    expect(fixture.set.mock.calls[1][1]).not.toBe(oldKey);
    expect(fixture.blobs.get(`image:${oldKey}`)).toBe(blob);
    // Cached historical bytes remain usable without cloud permission.
    fixture.mode = "offline";
    expect(await cacheImageUrl("https://cdn.invalid/media", "reused")).toEqual({
      urlToUse: "blob:fixture",
      isCached: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never retries a quota write after switching", async () => {
    const quota = deferred<void>();
    fixture.set.mockRejectedValueOnce(
      new DOMException("full", "QuotaExceededError")
    );
    fixture.quota.mockReturnValueOnce(quota.promise);
    const request = cacheSet("image", "reused", blob);
    const rejected = aborts(request);
    await vi.waitFor(() => expect(fixture.quota).toHaveBeenCalled());
    const suspension = rendererLibrary.suspend();
    quota.resolve();
    await suspension;
    await rejected;
    expect(fixture.set).toHaveBeenCalledTimes(1);
  });

  it.each([cacheImageUrl, cacheVideoUrl])(
    "cancels late abort-ignoring headers and drains body cleanup (%#)",
    async (read) => {
      const headers = deferred<Response>();
      const cleanup = deferred<void>();
      const cancel = vi.fn(() => cleanup.promise);
      fetchMock.mockReturnValueOnce(headers.promise);
      const request = read("https://cdn.invalid/media", "reused");
      const rejected = aborts(request);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      let drained = false;
      const suspension = rendererLibrary.suspend().then(() => {
        drained = true;
      });
      headers.resolve(new Response(new ReadableStream({ cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(drained).toBe(false);
      cleanup.resolve();
      await suspension;
      await rejected;
      expect(fixture.set).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    }
  );

  it("stops pending video bodies/progress and awaits actual cancellation even with a caller signal", async () => {
    const cleanup = deferred<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const progress = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-length": "50" }
      })
    );
    const request = downloadVideoInChunks(
      "https://cdn.invalid/video",
      progress,
      "reused",
      new AbortController().signal
    );
    const rejected = aborts(request);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    let drained = false;
    const suspension = rendererLibrary.suspend().then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(drained).toBe(false);
    cleanup.resolve();
    await suspension;
    await rejected;
    expect(progress).not.toHaveBeenCalled();
    expect(fixture.set).not.toHaveBeenCalled();
  });

  it.each([
    saveFrameToCache,
    (id: string, frame: number, url: string) =>
      saveFilmstripToCache(id, frame, url)
  ])(
    "does not save a late frame/filmstrip body into the next library (%#)",
    async (save) => {
      const body = deferred<Blob>();
      fetchMock.mockResolvedValueOnce({ ok: true, blob: () => body.promise });
      const request = save("reused", 24, "data:image/png;base64,AAAA");
      const rejected = aborts(request);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const suspension = rendererLibrary.suspend();
      body.resolve(blob);
      await suspension;
      rendererLibrary.reset();
      await rejected;
      expect(fixture.set).not.toHaveBeenCalled();
    }
  );

  it.each([getFrameFromCache, getFilmstripFromCache])(
    "owns native FileReader callbacks until loadend (%#)",
    async (read) => {
      fixture.get.mockResolvedValueOnce(blob);
      const readers: Array<{
        result: string;
        onloadend: () => void;
        abort: ReturnType<typeof vi.fn>;
      }> = [];
      vi.stubGlobal(
        "FileReader",
        class {
          result = "data:old-library";
          onloadend = () => {};
          abort = vi.fn();
          readAsDataURL() {
            readers.push(this);
          }
        }
      );
      const request = read("reused", 24);
      const rejected = aborts(request);
      await vi.waitFor(() => expect(readers).toHaveLength(1));
      const reader = readers[0];
      let drained = false;
      const suspension = rendererLibrary.suspend().then(() => {
        drained = true;
      });
      expect(reader.abort).toHaveBeenCalled();
      await flush();
      expect(drained).toBe(false);
      reader.onloadend();
      await suspension;
      rendererLibrary.reset();
      await rejected;
    }
  );

  it("does not save a late decoded first frame or return it as a successful preview", async () => {
    const frame = deferred<string>();
    vi.mocked(extractFrameFromVideo).mockReturnValueOnce(frame.promise);
    const request = resolveCachedVideoPreview({
      assetId: "reused",
      videoUrl: "mago-media://asset/reused",
      fps: 24
    });
    const rejected = aborts(request);
    await vi.waitFor(() => expect(extractFrameFromVideo).toHaveBeenCalled());
    await rendererLibrary.suspend();
    rendererLibrary.reset();
    frame.resolve("data:old-frame");
    await rejected;
    expect(fixture.set).not.toHaveBeenCalled();
  });

  it("rejects active/queued scheduler jobs, drains active work and never requeues it in the replacement", async () => {
    const library = new RendererLibrarySession();
    const scheduler = new MediaDownloadScheduler(library);
    const body = deferred<string>();
    const origin = library.capture();
    const old = scheduler.enqueue({
      key: "video:reused",
      assetId: "reused",
      kind: "video",
      run: () => body.promise
    });
    const oldRejected = aborts(old);
    const queued = vi.fn(async () => "never");
    const second = scheduler.enqueue({
      key: "video:queued",
      assetId: "queued",
      kind: "video",
      run: queued
    });
    const secondRejected = aborts(second);
    await flush();
    const suspension = library.suspend();
    await oldRejected;
    await secondRejected;
    body.resolve("old");
    await suspension;
    library.reset();
    await aborts(
      scheduler.enqueue({
        key: "video:reused",
        assetId: "reused",
        kind: "video",
        work: origin,
        run: queued
      })
    );
    expect(
      await scheduler.enqueue({
        key: "video:reused",
        assetId: "reused",
        kind: "video",
        run: async () => "new"
      })
    ).toBe("new");
    await scheduler.retryAsset("queued");
    await flush();
    expect(queued).not.toHaveBeenCalled();
    expect(scheduler.getSnapshot()).toEqual({
      queued: 0,
      downloading: 0,
      failed: 0,
      ready: 1
    });
    await library.suspend();
  });

  it("waits for preload registration and refuses dispatch if registration discovers suspension", async () => {
    const registered = deferred<void>();
    fixture.watch.mockReturnValueOnce(registered.promise);
    const library = new RendererLibrarySession();
    const work = library.capture();
    const dispatch = vi.fn(async () => "never");
    const request = work.boundary(dispatch);
    const rejected = aborts(request);
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
    const suspension = library.suspend();
    registered.resolve();
    await suspension;
    await rejected;
    expect(dispatch).not.toHaveBeenCalled();
  });
});
