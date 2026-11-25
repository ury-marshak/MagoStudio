import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";
import { releaseRendererObjectUrl } from "@/platform/rendererObjectUrl";

import { getImageAsset } from "./getImageAsset.local";
import { getRemoteImageAsset } from "./getRemoteImageAsset";

const mocks = vi.hoisted(() => ({
  local: vi.fn(),
  metadata: vi.fn(),
  cache: vi.fn(),
  download: vi.fn()
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get: mocks.metadata }
}));
vi.mock("../utils/cacheStorage", () => ({ cacheGet: mocks.cache }));
vi.mock("../utils/downloadImageBlob", () => ({
  downloadImageBlob: mocks.download
}));

const id = "reused";
const remote = "https://fixture.invalid/image.png";
const response = { data: { original_url: remote } };
const bytes = new Blob(["fixture"]);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("mago", {
    assets: { get: mocks.local },
    account: { mode: "cloud" }
  });
  let next = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:fixture-${++next}`
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.metadata.mockResolvedValue(response);
  mocks.download.mockResolvedValue(bytes);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("does not fall back from a retired desktop asset lookup or dispatch a queued retry", async () => {
  const library = new RendererLibrarySession();
  const work = library.capture();
  const wait = Promise.withResolvers<null>();
  mocks.local.mockReturnValueOnce(wait.promise);
  const rejected = expect(getImageAsset(id, work)).rejects.toMatchObject({
    name: "AbortError"
  });
  await vi.waitFor(() => expect(mocks.local).toHaveBeenCalledOnce());
  await library.suspend();
  library.reset();
  wait.resolve(null);
  await rejected;
  await expect(getImageAsset(id, work)).rejects.toMatchObject({
    name: "AbortError"
  });
  expect(mocks.local).toHaveBeenCalledOnce();
  expect(mocks.metadata).not.toHaveBeenCalled();
});

it("does not open cache or download after a late metadata response", async () => {
  const library = new RendererLibrarySession();
  const work = library.capture();
  const wait = Promise.withResolvers<typeof response>();
  mocks.metadata.mockReturnValueOnce(wait.promise);
  const rejected = expect(getRemoteImageAsset(id, work)).rejects.toMatchObject({
    name: "AbortError"
  });
  await vi.waitFor(() =>
    expect(mocks.metadata).toHaveBeenCalledExactlyOnceWith("/assets/reused", {
      signal: work.signal
    })
  );
  await library.suspend();
  library.reset();
  wait.resolve(response);
  await rejected;
  expect(mocks.cache).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it.each(["cache", "download"] as const)(
  "rejects late %s bytes without creating an object URL",
  async (stage) => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const wait = Promise.withResolvers<Blob>();
    mocks[stage].mockReturnValueOnce(wait.promise);
    const rejected = expect(
      getRemoteImageAsset(id, work)
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() =>
      expect(mocks[stage]).toHaveBeenCalledExactlyOnceWith(
        ...(stage === "cache" ? ["image", id, work] : [remote, id, work])
      )
    );
    await library.suspend();
    library.reset();
    wait.resolve(bytes);
    await rejected;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    if (stage === "cache") expect(mocks.download).not.toHaveBeenCalled();
  }
);

it("releases each acquired object URL once and keeps same-ID replacement URLs usable", async () => {
  const library = new RendererLibrarySession();
  const work = library.capture();
  mocks.cache.mockResolvedValueOnce(bytes);
  const cached = (await getRemoteImageAsset(id, work)).urlToUse;
  const downloaded = (await getRemoteImageAsset(id, work)).urlToUse;
  expect(cached).not.toBe(downloaded);
  releaseRendererObjectUrl(cached);
  await library.suspend();
  library.reset();
  releaseRendererObjectUrl(downloaded);
  expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([
    [cached],
    [downloaded]
  ]);
  const replacement = (await getRemoteImageAsset(id, library.capture()))
    .urlToUse;
  expect(replacement).not.toBe(downloaded);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(replacement);
  await library.suspend();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(replacement);
});
