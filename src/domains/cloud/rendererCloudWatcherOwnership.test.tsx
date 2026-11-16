import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  list: vi.fn(),
  link: vi.fn(),
  status: vi.fn(),
  fail: vi.fn(),
  finish: vi.fn(),
  backend: vi.fn(),
  cloud: true,
  stop: undefined as undefined | (() => Promise<void>),
  reset: undefined as undefined | (() => void)
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => ({
    library: {
      onWillChange: async (stop: () => Promise<void>) => {
        fixture.stop = stop;
      },
      onDidChange: (reset: () => void) => {
        fixture.reset = reset;
      }
    },
    cloud: {
      links: { get: fixture.link },
      renders: {
        listActive: fixture.list,
        setStatus: fixture.status,
        fail: fixture.fail,
        finish: fixture.finish
      }
    }
  })
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get: fixture.backend }
}));
vi.mock("@/platform/renderTarget", () => ({
  isCloudRenderAvailable: () => fixture.cloud
}));

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { pollCloudImageRenders } from "./pollCloudImageRenders";
import { pollCloudRenders } from "./pollCloudRenders";
import { settleCloudRenderFromAsset } from "./settleCloudRenderFromAsset";
import { useCloudRenderWatcher } from "./useCloudRenderWatcher";

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
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const api = (get = vi.fn()) => ({ get, post: vi.fn() });
const job = (kind = "video") => ({
  id: "reused-job",
  projectId: "reused-project",
  cloudAssetId: "remote-asset",
  cloudClipId: "remote-clip",
  kind,
  status: "INQUEUE",
  progress: 0
});
const queue = (status: string) => [
  {
    id: "queue-item",
    asset_id: "remote-asset",
    status,
    created_at: "2026-08-28T08:00:00+00:00",
    render_started_at: "2026-08-28T08:00:05",
    progress: 50
  }
];
const aborts = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: "AbortError" });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.cloud = true;
  fixture.list.mockResolvedValue([job()]);
  fixture.link.mockResolvedValue({ cloudId: "remote-project" });
  fixture.status.mockResolvedValue(undefined);
  fixture.fail.mockResolvedValue(undefined);
  fixture.finish.mockResolvedValue(undefined);
  fixture.backend.mockResolvedValue({ data: queue("RUNNING") });
});
afterEach(async () => {
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
  vi.useRealTimers();
});

describe("origin-owned cloud render polling", () => {
  it("drains a listed-job IPC but never links its late reused IDs after reset", async () => {
    const listed = deferred<ReturnType<typeof job>[]>();
    fixture.list.mockReturnValueOnce(listed.promise);
    const remote = api();
    const request = pollCloudRenders(remote);
    const rejected = aborts(request);
    await flush();
    let stopped = false;
    const stop = fixture.stop!().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    listed.resolve([job()]);
    await stop;
    fixture.reset!();
    await rejected;
    expect(fixture.link).not.toHaveBeenCalled();
    expect(remote.get).not.toHaveBeenCalled();
  });

  it("drains a link lookup without dispatching the old project's backend queue", async () => {
    const link = deferred<{ cloudId: string }>();
    fixture.link.mockReturnValueOnce(link.promise);
    const remote = api();
    const request = pollCloudRenders(remote);
    const rejected = aborts(request);
    await flush();
    const stop = fixture.stop!();
    link.resolve({ cloudId: "old-project" });
    await stop;
    fixture.reset!();
    await rejected;
    expect(remote.get).not.toHaveBeenCalled();
  });

  it.each(["RUNNING", "FAILED", "CANCELLED", "FINISHED"])(
    "suppresses a late video %s response without waiting for it on teardown",
    async (status) => {
      const response = deferred<unknown>();
      const remote = api(vi.fn().mockReturnValueOnce(response.promise));
      const request = pollCloudRenders(remote);
      const rejected = aborts(request);
      await flush();
      await fixture.stop!();
      fixture.reset!();
      response.resolve(queue(status));
      await rejected;
      expect(remote.get).toHaveBeenCalledOnce();
      expect(fixture.status).not.toHaveBeenCalled();
      expect(fixture.fail).not.toHaveBeenCalled();
      expect(fixture.finish).not.toHaveBeenCalled();
    }
  );

  it("does not settle from an unfiltered queue that returns after replacement", async () => {
    const response = deferred<unknown>();
    const remote = api(
      vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(response.promise)
    );
    const request = pollCloudRenders(remote);
    const rejected = aborts(request);
    await flush();
    expect(remote.get).toHaveBeenLastCalledWith("/queue/unfiltered");
    await fixture.stop!();
    fixture.reset!();
    response.resolve([]);
    await rejected;
    expect(remote.get).toHaveBeenCalledTimes(2);
    expect(fixture.fail).not.toHaveBeenCalled();
  });

  it.each(["running", "failed", "success", "404"])(
    "refuses a late image %s response",
    async (status) => {
      fixture.list.mockResolvedValue([job("img2img")]);
      const response = deferred<unknown>();
      const request = pollCloudImageRenders(
        api(vi.fn().mockReturnValueOnce(response.promise))
      );
      const rejected = aborts(request);
      await flush();
      await fixture.stop!();
      fixture.reset!();
      if (status === "404") response.reject({ response: { status: 404 } });
      else
        response.resolve({
          render_status: status,
          progress: 0.5,
          output_url: "https://output.invalid/result"
        });
      await rejected;
      expect(fixture.status).not.toHaveBeenCalled();
      expect(fixture.fail).not.toHaveBeenCalled();
      expect(fixture.finish).not.toHaveBeenCalled();
    }
  );

  it.each(["ready", "pending", "gone"])(
    "retains settlement origin for a late %s asset",
    async (kind) => {
      const response = deferred<unknown>();
      const request = settleCloudRenderFromAsset(
        api(vi.fn().mockReturnValueOnce(response.promise)),
        { id: "reused-job", cloudAssetId: "remote-asset" },
        "cancelled"
      );
      const rejected = aborts(request);
      await flush();
      await fixture.stop!();
      fixture.reset!();
      if (kind === "gone") response.reject({ response: { status: 404 } });
      else
        response.resolve(
          kind === "ready" ? { s3_url: "https://output.invalid/video" } : {}
        );
      await rejected;
      expect(fixture.fail).not.toHaveBeenCalled();
      expect(fixture.finish).not.toHaveBeenCalled();
    }
  );

  it.each(["status", "fail", "finish"] as const)(
    "drains an issued %s IPC before acknowledgement and suppresses subsequent jobs",
    async (method) => {
      fixture.list.mockResolvedValue([
        job("img2img"),
        { ...job("img2img"), id: "second" }
      ]);
      const body = deferred<void>();
      fixture[method].mockReturnValueOnce(body.promise);
      const status = { status: "running", fail: "failed", finish: "success" }[
        method
      ];
      const remote = api(
        vi.fn().mockResolvedValue({
          render_status: status,
          progress: 0.5,
          output_url: "https://output.invalid/image"
        })
      );
      const request = pollCloudImageRenders(remote);
      const rejected = aborts(request);
      await flush();
      expect(fixture[method]).toHaveBeenCalledOnce();
      let stopped = false;
      const stop = fixture.stop!().then(() => {
        stopped = true;
      });
      await flush();
      expect(stopped).toBe(false);
      body.resolve();
      await stop;
      fixture.reset!();
      await rejected;
      expect(remote.get).toHaveBeenCalledOnce();
    }
  );

  it("restarts the mounted watcher only on reset and rejects old invalidation/interval callbacks", async () => {
    vi.useFakeTimers();
    const response = deferred<{ data: unknown }>();
    fixture.backend.mockReturnValueOnce(response.promise);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useCloudRenderWatcher(), { wrapper });
    await act(flush);
    expect(fixture.backend).toHaveBeenCalledOnce();
    const oldSignal = fixture.backend.mock.calls[0][1].signal as AbortSignal;
    await act(async () => {
      await fixture.stop!();
    });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(fixture.backend).toHaveBeenCalledOnce();
    await act(async () => {
      fixture.reset!();
    });
    await act(flush);
    expect(fixture.backend).toHaveBeenCalledTimes(2);
    invalidate.mockClear();
    await act(async () => {
      response.resolve({ data: queue("FAILED") });
      await flush();
    });
    expect(fixture.fail).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("keeps account-free mounting and interval ticks free of cloud IPC", async () => {
    fixture.cloud = false;
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useCloudRenderWatcher(), { wrapper });
    await act(flush);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.backend).not.toHaveBeenCalled();
  });
});
