import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { useIngestVideo } from "./useIngestVideo";

const { getToken, get, post, upload, cacheSet, mirror, waitForPollTick } =
  vi.hoisted(() => ({
    getToken: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    upload: vi.fn(),
    cacheSet: vi.fn(),
    mirror: vi.fn(),
    waitForPollTick: vi.fn()
  }));
vi.mock("@platform/identity", () => ({ useAuth: () => ({ getToken }) }));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get, post }
}));
vi.mock("../asset/api/putAssetOnS3", () => ({ uploadAssetToS3: upload }));
vi.mock("../asset/utils/cacheStorage", () => ({ cacheSet }));
vi.mock("@domains/scriptProject/syncCloudScriptProjects", () => ({
  syncCloudProjectMetadata: mirror
}));
vi.mock("./utils/waitForPollTick", () => ({ waitForPollTick }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const status = { data: { asset: { data: { status: "ingested" } } } };
const params = {
  projectId: "same-project",
  shotId: "same-shot",
  file: new File(["video"], "video.mp4", { type: "video/mp4" })
};

function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const { result } = renderHook(useIngestVideo, {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  });
  return { result, invalidate };
}

beforeEach(() => {
  rendererLibrary.reset();
  vi.resetAllMocks();
  getToken.mockResolvedValue("token");
  get.mockResolvedValue(status);
  post.mockImplementation(async (url: string) => ({
    data: url.endsWith("/ingestion")
      ? { job_id: "job" }
      : {
          video_url: "https://upload.test/video",
          meta_url: "https://upload.test/meta",
          timeline: {
            layers: [
              {
                id: "same-layer",
                name: "source",
                type: "IMAGE",
                created_at: "2026-01-01",
                clips: [{ asset: { id: "same-asset" } }]
              }
            ]
          }
        }
  }));
  for (const mock of [upload, cacheSet, mirror, waitForPollTick]) {
    mock.mockResolvedValue(undefined);
  }
});

afterEach(async () => {
  await rendererLibrary.suspend();
  vi.restoreAllMocks();
});

it.each(["credential", "status"] as const)(
  "drops an old ingestion waiting for %s when a replacement reuses its IDs",
  async (phase) => {
    const waiting = deferred<void>();
    const late = deferred<void>();
    const delayed = phase === "credential" ? getToken : get;
    delayed.mockImplementationOnce(async () => {
      waiting.resolve();
      await late.promise;
      return phase === "credential" ? "old-token" : status;
    });
    const onProgress = vi.fn();
    const { result, invalidate } = setup();
    const old = result.current.ingestVideo({ ...params, onProgress });
    await Promise.race([waiting.promise, old]);
    await rendererLibrary.suspend();
    rendererLibrary.reset();
    await expect(result.current.ingestVideo(params)).resolves.toMatchObject({
      outcome: "ingested",
      assetId: "same-asset"
    });
    const counts = [get, mirror, cacheSet, invalidate, onProgress].map(
      (mock) => mock.mock.calls.length
    );
    late.resolve();
    await expect(old).resolves.toEqual({ outcome: "cancelled" });
    expect(
      [get, mirror, cacheSet, invalidate, onProgress].map(
        (mock) => mock.mock.calls.length
      )
    ).toEqual(counts);
  }
);

it("keeps detached mirroring and the cache write on the original work", async () => {
  const mirrored = deferred<void>();
  const cached = deferred<void>();
  const cacheEntered = deferred<void>();
  cacheSet.mockImplementationOnce((_kind, _asset, _file, work) =>
    work.boundary(async () => {
      cacheEntered.resolve();
      await cached.promise;
    })
  );
  mirror.mockReturnValueOnce(mirrored.promise);
  const { result, invalidate } = setup();
  await expect(
    result.current.ingestVideo({ ...params, awaitInvalidation: false })
  ).resolves.toMatchObject({
    outcome: "ingested"
  });
  await cacheEntered.promise;
  const origin = cacheSet.mock.calls[0][3];
  expect(mirror).toHaveBeenCalledWith("same-project", origin);
  let drained = false;
  const suspending = rendererLibrary.suspend().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(origin.signal.aborted).toBe(true);
  expect(drained).toBe(false);
  cached.resolve();
  await suspending;
  rendererLibrary.reset();
  await expect(result.current.ingestVideo(params)).resolves.toMatchObject({
    outcome: "ingested"
  });
  expect(cacheSet.mock.calls[1][3].signal).not.toBe(origin.signal);
  const calls = invalidate.mock.calls.slice();
  mirrored.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(invalidate.mock.calls).toEqual(calls);
});

it("refuses a caller's expired work rather than capturing again when ingestion starts", async () => {
  const origin = rendererLibrary.capture();
  await rendererLibrary.suspend();
  rendererLibrary.reset();
  const onProgress = vi.fn();
  const { result, invalidate } = setup();
  await expect(
    result.current.ingestVideo({ ...params, onProgress }, origin)
  ).resolves.toEqual({ outcome: "cancelled" });
  for (const mock of [
    post,
    getToken,
    get,
    upload,
    cacheSet,
    mirror,
    invalidate,
    onProgress
  ]) {
    expect(mock).not.toHaveBeenCalled();
  }
});

it("keeps explicit cancellation during the final status response from publishing success", async () => {
  const requested = deferred<void>();
  const response = deferred<typeof status>();
  get.mockImplementationOnce(() => {
    requested.resolve();
    return response.promise;
  });
  const controller = new AbortController();
  const { result, invalidate } = setup();
  const onProgress = vi.fn();
  const pending = result.current.ingestVideo({
    ...params,
    onProgress,
    signal: controller.signal
  });
  await Promise.race([requested.promise, pending]);
  controller.abort();
  response.resolve(status);
  await expect(pending).resolves.toEqual({ outcome: "cancelled" });
  expect(mirror).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(onProgress).not.toHaveBeenCalledWith(
    expect.objectContaining({ phase: "finalizing" })
  );
});
