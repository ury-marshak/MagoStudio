import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  read: vi.fn(),
  mirror: vi.fn(),
  asset: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  link: vi.fn(),
  patch: vi.fn(),
  cache: vi.fn(),
  cancel: vi.fn(),
  cacheAsset: vi.fn(),
  cancelAsset: vi.fn(),
  mode: "cloud",
  root: "a",
  stop: undefined as undefined | (() => Promise<void>),
  reset: undefined as undefined | (() => void)
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => ({
    account: { mode: fixture.mode },
    library: {
      get: async () => ({ rootPath: fixture.root }),
      onWillChange: async (stop: () => Promise<void>) => {
        fixture.stop = stop;
      },
      onDidChange: (reset: () => void) => {
        fixture.reset = reset;
      }
    },
    projects: {
      get: fixture.read,
      mirrorCloud: fixture.mirror,
      list: fixture.list,
      delete: fixture.remove,
      cacheCloudAsset: fixture.cacheAsset,
      cancelCloudAsset: fixture.cancelAsset
    },
    assets: { get: fixture.asset },
    cloud: { links: { get: fixture.link, patch: fixture.patch } },
    scriptProjects: {
      put: fixture.put,
      get: fixture.read,
      cacheMedia: fixture.cache,
      cancelMedia: fixture.cancel
    }
  })
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get: fixture.get, put: fixture.patch }
}));

import { mediaDownloads } from "@domains/asset/mediaDownloads";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import {
  readScriptProjectSnapshot,
  writeScriptProjectSnapshot
} from "./scriptProjectSnapshot.local";
import {
  deferCloudProjectCatalogSync,
  getCloudProjectCatalogSyncProgress,
  getCloudProjectSyncStatus,
  hydrateScriptMedia,
  subscribeCloudAssetReady,
  subscribeCloudProjectMetadata,
  syncCloudProject,
  syncCloudProjectMetadata,
  syncCloudScriptProjects
} from "./syncCloudScriptProjects.local";
import { useCloudProjectSync } from "./useCloudProjectSync.local";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const project = (type = "script_to_shots") => ({
  id: "reused",
  name: "Project",
  description: "",
  active: true,
  type,
  settings: {}
});
const snapshot = {
  state: { project_id: "reused", keys: [], shots: [] },
  scriptVersions: { active_version: null, versions: [] },
  planDetails: {},
  cut: { project_id: "reused", shots: [], missing: [], export: null }
};
const documents = [
  { asset_id: "reused-asset", url: "https://media.invalid/video.mp4" }
];
const aborts = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: "AbortError" });
const replace = async () => {
  await fixture.stop!();
  fixture.root = "b";
  fixture.reset!();
};

beforeEach(() => {
  vi.resetAllMocks();
  fixture.mode = "cloud";
  fixture.root = "a";
  fixture.put.mockResolvedValue(undefined);
  fixture.read.mockResolvedValue(null);
  fixture.mirror.mockResolvedValue(true);
  fixture.asset.mockResolvedValue(null);
  fixture.list.mockResolvedValue([]);
  fixture.link.mockResolvedValue(null);
  fixture.cache.mockResolvedValue(undefined);
  fixture.cancel.mockResolvedValue(undefined);
  fixture.cacheAsset.mockResolvedValue(true);
  fixture.cancelAsset.mockResolvedValue(undefined);
  fixture.get.mockImplementation(async (url: string) => {
    if (url === "/projects/homepage/list") return { data: { items: [] } };
    if (url === "/projects/reused") return { data: project() };
    if (url.endsWith("/state")) return { data: snapshot.state };
    if (url.endsWith("/script")) return { data: snapshot.scriptVersions };
    if (url.endsWith("/cut")) return { data: snapshot.cut };
    if (url.startsWith("/assets/"))
      return { data: { original_url: "https://media.invalid/video.mp4" } };
    throw new Error(`Unexpected backend ${url}`);
  });
});
afterEach(async () => {
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("desktop cloud-sync producer ownership", () => {
  it("discards a late catalog without blocking teardown or changing replacement progress", async () => {
    const old = deferred<{ data: unknown }>();
    fixture.get.mockReturnValueOnce(old.promise);
    const first = syncCloudScriptProjects();
    await flush();
    await replace();
    const next = deferred<{ data: unknown }>();
    fixture.get.mockReturnValueOnce(next.promise);
    const second = syncCloudScriptProjects();
    old.resolve({ data: { items: [project()] } });
    await first;
    expect(getCloudProjectSyncStatus()).toBe(true);
    expect(getCloudProjectCatalogSyncProgress()).toBe(null);
    expect(fixture.mirror).not.toHaveBeenCalled();
    next.resolve({ data: { items: [] } });
    await second;
    expect(getCloudProjectSyncStatus()).toBe(false);
  });

  it("does not write a catalog row queued behind its interactive timer after reset", async () => {
    vi.useFakeTimers();
    fixture.get.mockResolvedValueOnce({ data: { items: [project()] } });
    const sync = syncCloudScriptProjects();
    await flush();
    expect(getCloudProjectCatalogSyncProgress()).toEqual({
      completed: 0,
      total: 1
    });
    await replace();
    await vi.advanceTimersByTimeAsync(100);
    await sync;
    expect(fixture.mirror).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
  });

  it("drops deferred navigation refresh even after its timer woke and awaited an old request", async () => {
    vi.useFakeTimers();
    const old = deferred<{ data: unknown }>();
    fixture.get.mockReturnValueOnce(old.promise);
    const sync = syncCloudScriptProjects();
    await flush();
    deferCloudProjectCatalogSync();
    await vi.advanceTimersByTimeAsync(1500);
    await replace();
    old.resolve({ data: { items: [] } });
    await sync;
    await flush();
    expect(fixture.get).toHaveBeenCalledOnce();
  });

  it("drains an issued mirror write, suppressing metadata and old finally cleanup", async () => {
    vi.useFakeTimers();
    const write = deferred<boolean>();
    fixture.mirror.mockReturnValueOnce(write.promise);
    fixture.get.mockResolvedValueOnce({
      data: { items: [project("timeline")] }
    });
    const metadata = vi.fn();
    subscribeCloudProjectMetadata(metadata);
    const sync = syncCloudScriptProjects();
    await vi.advanceTimersByTimeAsync(75);
    expect(fixture.mirror).toHaveBeenCalledOnce();
    let stopped = false;
    const stop = fixture.stop!().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    write.resolve(true);
    await stop;
    fixture.reset!();
    await sync;
    expect(metadata).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
  });

  it.each(["script_to_shots", "timeline"])(
    "refuses late %s project details before any local write",
    async (type) => {
      const response = deferred<{ data: unknown }>();
      fixture.get.mockReturnValueOnce(response.promise);
      const sync = syncCloudProject("reused");
      const rejected = aborts(sync);
      await flush();
      await replace();
      response.resolve({ data: project(type) });
      await rejected;
      expect(fixture.put).not.toHaveBeenCalled();
      expect(fixture.mirror).not.toHaveBeenCalled();
      expect(fixture.cache).not.toHaveBeenCalled();
    }
  );

  it("retains metadata-only origin independently of the project-sync map", async () => {
    const response = deferred<{ data: unknown }>();
    fixture.get.mockReturnValueOnce(response.promise);
    const sync = syncCloudProjectMetadata("reused");
    const rejected = aborts(sync);
    await flush();
    await replace();
    response.resolve({ data: project("timeline") });
    await rejected;
    expect(fixture.mirror).not.toHaveBeenCalled();
  });

  it("drains a timeline read and never enqueues its late reused assets", async () => {
    fixture.get.mockResolvedValueOnce({ data: project("timeline") });
    const read = deferred<unknown>();
    fixture.read.mockReturnValueOnce(read.promise);
    const sync = syncCloudProject("reused");
    const rejected = aborts(sync);
    await flush();
    const stop = fixture.stop!();
    read.resolve({
      timelines: [
        {
          id: "reused-shot",
          layers: [
            {
              clips: [
                { asset: { id: "reused-asset", type: "VIDEO", data: {} } }
              ]
            }
          ]
        }
      ]
    });
    await stop;
    fixture.reset!();
    await rejected;
    expect(fixture.get).toHaveBeenCalledOnce();
    expect(fixture.cacheAsset).not.toHaveBeenCalled();
    expect(mediaDownloads.getAssetState("reused-asset")).toBeUndefined();
  });

  it("cannot let an old detail operation remove or coalesce a replacement with the same project ID", async () => {
    const old = deferred<{ data: unknown }>();
    fixture.get.mockReturnValueOnce(old.promise);
    const first = syncCloudProject("reused");
    const rejected = expect(first).rejects.toThrow("old transport failed");
    await flush();
    await replace();
    const next = deferred<{ data: unknown }>();
    fixture.get.mockReturnValueOnce(next.promise);
    const second = syncCloudProject("reused");
    old.reject(new Error("old transport failed"));
    // The original transport error is retained, but cannot mutate new maps.
    await rejected;
    expect(getCloudProjectSyncStatus()).toBe(true);
    expect(syncCloudProject("reused", "another-shot")).toBe(second);
    next.resolve({ data: project() });
    await second;
  });

  it("keeps scheduler origin explicit and drains cache and cancellation acknowledgements without publishing old assets", async () => {
    const cached = deferred<void>();
    const cancelled = deferred<void>();
    fixture.cache.mockReturnValueOnce(cached.promise);
    fixture.cancel.mockReturnValueOnce(cancelled.promise);
    const enqueue = vi.spyOn(mediaDownloads, "enqueue");
    const work = rendererLibrary.capture();
    const listener = vi.fn();
    subscribeCloudAssetReady(listener);
    const hydration = hydrateScriptMedia(
      "reused",
      documents,
      work.signal,
      work
    );
    await flush();
    expect(enqueue.mock.calls[0][0].work?.signal.aborted).toBe(false);
    expect(fixture.cache).toHaveBeenCalledOnce();
    let stopped = false;
    const stop = fixture.stop!().then(() => {
      stopped = true;
    });
    await flush();
    expect(fixture.cancel).toHaveBeenCalledWith("reused", documents[0].url);
    cached.resolve();
    await flush();
    expect(stopped).toBe(false);
    cancelled.resolve();
    await stop;
    fixture.reset!();
    await hydration;
    expect(listener).not.toHaveBeenCalled();
    expect(enqueue.mock.calls[0][0].work?.signal.aborted).toBe(true);
    const replacementListener = vi.fn();
    subscribeCloudAssetReady(replacementListener);
    await hydrateScriptMedia(
      "reused",
      documents,
      rendererLibrary.capture().signal
    );
    expect(replacementListener).toHaveBeenCalledWith("reused", "reused-asset");
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects a producer that wakes after reset with its old explicit origin, before queue registration", async () => {
    const work = rendererLibrary.capture();
    await work.ready();
    await replace();
    await aborts(hydrateScriptMedia("reused", documents, work.signal, work));
    expect(fixture.cache).not.toHaveBeenCalled();
    expect(mediaDownloads.getAssetState("reused-asset")).toBeUndefined();
  });

  it("drains snapshot writes and refuses post-write media reads after teardown", async () => {
    const written = deferred<void>();
    fixture.put.mockReturnValueOnce(written.promise);
    const write = writeScriptProjectSnapshot({
      projectId: "reused",
      state: snapshot.state
    });
    const rejected = aborts(write);
    await flush();
    const stop = fixture.stop!();
    written.resolve();
    await stop;
    fixture.reset!();
    await rejected;
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.cache).not.toHaveBeenCalled();
  });

  it("cannot reuse a snapshot read or hydrate its result in a replacement with the same ID", async () => {
    const result = deferred<unknown>();
    fixture.read.mockReturnValueOnce(result.promise);
    const first = readScriptProjectSnapshot("reused");
    const rejected = aborts(first);
    await flush();
    const stop = fixture.stop!();
    result.resolve(snapshot);
    await stop;
    fixture.reset!();
    await rejected;
    fixture.read.mockResolvedValueOnce({
      ...snapshot,
      state: { replacement: true }
    });
    expect((await readScriptProjectSnapshot("reused"))?.state).toEqual({
      replacement: true
    });
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it("leaves account-free snapshots and local URLs intact without catalog or media transport", async () => {
    fixture.mode = "offline";
    fixture.read.mockResolvedValue(snapshot);
    await syncCloudScriptProjects();
    await syncCloudProject("reused");
    await writeScriptProjectSnapshot({
      projectId: "reused",
      state: { url: "https://historical.invalid/original" }
    });
    expect(fixture.put).toHaveBeenCalledWith({
      projectId: "reused",
      state: { url: "https://historical.invalid/original" }
    });
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.cache).not.toHaveBeenCalled();
  });
});

describe("mounted cloud-sync subscriptions and timers", () => {
  it("drains the hook's selected read and refuses to capture a new session for its late refresh", async () => {
    const read = deferred<unknown>();
    fixture.read.mockReturnValueOnce(read.promise);
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useCloudProjectSync("reused"), { wrapper });
    await act(flush);
    const stop = fixture.stop!();
    await act(async () => {
      read.resolve({ origin: "cloud" });
      await stop;
    });
    expect(fixture.get).not.toHaveBeenCalled();
    hook.unmount();
    fixture.reset!();
  });

  it("suppresses queued homepage invalidation timers and restarts only for the new library", async () => {
    vi.useFakeTimers();
    fixture.get.mockResolvedValueOnce({
      data: { items: [project("timeline")] }
    });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useCloudProjectSync(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });
    expect(fixture.mirror).toHaveBeenCalledOnce();
    await act(async () => {
      await fixture.stop!();
    });
    invalidate.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(invalidate).not.toHaveBeenCalled();
    fixture.get.mockResolvedValueOnce({ data: { items: [] } });
    await act(async () => {
      fixture.reset!();
      await flush();
    });
    expect(
      fixture.get.mock.calls.filter(
        ([url]) => url === "/projects/homepage/list"
      )
    ).toHaveLength(2);
    expect(invalidate).toHaveBeenCalled();
    hook.unmount();
  });
});

it("does not apply late historical plan details or republish metadata after replacement", async () => {
  const plan = deferred<{ data: unknown }>();
  const normal = fixture.get.getMockImplementation()!;
  fixture.get.mockImplementation((url: string) => {
    if (url.endsWith("/script"))
      return Promise.resolve({
        data: { active_version: 1, versions: [{ version: 1, plan_id: "plan" }] }
      });
    if (url === "/agent/plans/plan") return plan.promise;
    return normal(url);
  });
  const sync = syncCloudProject("reused");
  const rejected = aborts(sync);
  await flush();
  expect(fixture.put).toHaveBeenCalledTimes(2);
  await replace();
  const listener = vi.fn();
  subscribeCloudProjectMetadata(listener);
  plan.resolve({ data: { id: "plan", status: "old" } });
  await rejected;
  expect(fixture.put).toHaveBeenCalledTimes(2);
  expect(fixture.read).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
});

it("refuses a late asset URL before cache IPC and keeps scheduler state scoped", async () => {
  const asset = deferred<{ data: unknown }>();
  const normal = fixture.get.getMockImplementation()!;
  fixture.get.mockImplementation((url: string) => {
    if (url === "/projects/reused")
      return Promise.resolve({ data: project("timeline") });
    if (url.startsWith("/assets/")) return asset.promise;
    return normal(url);
  });
  fixture.read.mockResolvedValue({
    timelines: [
      {
        id: "shot",
        layers: [
          {
            clips: [{ asset: { id: "reused-asset", type: "VIDEO", data: {} } }]
          }
        ]
      }
    ]
  });
  const sync = syncCloudProject("reused");
  await flush();
  expect(fixture.get).toHaveBeenLastCalledWith(
    "/assets/reused-asset",
    expect.anything()
  );
  // The scheduler drains its issued run, including a noncooperative URL read.
  const stop = fixture.stop!();
  asset.resolve({ data: { original_url: "https://media.invalid/old.mp4" } });
  await stop;
  fixture.reset!();
  await sync;
  expect(fixture.cacheAsset).not.toHaveBeenCalled();
  expect(mediaDownloads.getAssetState("reused-asset")).toBeUndefined();
});

it("drains a video-cache IPC and its local cancellation response without old asset-ready events", async () => {
  const cached = deferred<boolean>();
  const cancelled = deferred<void>();
  fixture.cacheAsset.mockReturnValueOnce(cached.promise);
  fixture.cancelAsset.mockReturnValueOnce(cancelled.promise);
  fixture.get.mockResolvedValueOnce({ data: project("timeline") });
  fixture.read.mockResolvedValue({
    timelines: [
      {
        id: "shot",
        layers: [
          {
            clips: [{ asset: { id: "reused-asset", type: "VIDEO", data: {} } }]
          }
        ]
      }
    ]
  });
  const listener = vi.fn();
  subscribeCloudAssetReady(listener);
  const sync = syncCloudProject("reused");
  await flush();
  expect(fixture.cacheAsset).toHaveBeenCalledOnce();
  let stopped = false;
  const stop = fixture.stop!().then(() => {
    stopped = true;
  });
  await flush();
  expect(fixture.cancelAsset).toHaveBeenCalledWith("reused", "reused-asset");
  cached.resolve(true);
  await flush();
  expect(stopped).toBe(false);
  cancelled.resolve();
  await stop;
  fixture.reset!();
  await sync;
  expect(listener).not.toHaveBeenCalled();
});

it.each(["mark", "remove"])(
  "does not %s an old mirror after a late catalog-cleanup response",
  async (action) => {
    const detail = deferred<{ data: unknown }>();
    fixture.get.mockImplementation((url: string) => {
      if (url === "/projects/homepage/list")
        return Promise.resolve({ data: { items: [] } });
      return detail.promise;
    });
    fixture.list.mockResolvedValue([
      { id: "reused", origin: action === "mark" ? "local" : "cloud" }
    ]);
    fixture.link.mockResolvedValue({ cloudId: "remote-project", data: {} });
    const sync = syncCloudScriptProjects();
    await flush();
    expect(fixture.get).toHaveBeenCalledTimes(2);
    await replace();
    detail.resolve({
      data: {
        name: "old remote project",
        settings: { mirroredLocalProjectId: "original" }
      }
    });
    await sync;
    expect(fixture.patch).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  }
);

it("suppresses a cached snapshot's late post-write read before hydration", async () => {
  const result = deferred<unknown>();
  fixture.read.mockReturnValueOnce(result.promise);
  const write = writeScriptProjectSnapshot({
    projectId: "reused",
    state: snapshot.state
  });
  const rejected = aborts(write);
  await flush();
  expect(fixture.read).toHaveBeenCalledOnce();
  const stop = fixture.stop!();
  result.resolve({ ...snapshot, cut: { shots: documents } });
  await stop;
  fixture.reset!();
  await rejected;
  expect(fixture.cache).not.toHaveBeenCalled();
});
