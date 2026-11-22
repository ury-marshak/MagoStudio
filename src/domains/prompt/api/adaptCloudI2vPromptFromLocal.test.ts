import { VideoEngine } from "@models/video/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

import { adaptCloudI2vPromptFromLocal } from "./adaptCloudI2vPromptFromLocal";

const bridge = vi.hoisted(() => ({
  listAll: vi.fn(),
  getLink: vi.fn(),
  putLink: vi.fn(),
  assetInfo: vi.fn(),
  uploadAsset: vi.fn(),
  post: vi.fn()
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: false,
  getLocalDesktopApi: () => ({
    vlm: { hasExternalText: async () => false },
    projects: { listAll: bridge.listAll },
    cloud: {
      links: { get: bridge.getLink, put: bridge.putLink },
      assetInfo: bridge.assetInfo,
      uploadAsset: bridge.uploadAsset
    }
  })
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { post: bridge.post }
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const start = (sourceVideoTrackId?: string) => {
  const library = new RendererLibrarySession();
  const caller = new AbortController();
  const result = adaptCloudI2vPromptFromLocal(
    {
      prompt: "original",
      sourceVideoTrackId,
      referenceImageAssetIds: ["reference"],
      cloudEngine: VideoEngine.minimax_reference
    },
    library.capture(),
    caller.signal
  );
  return { result, library, caller };
};

beforeEach(() => {
  vi.resetAllMocks();
  bridge.getLink.mockResolvedValue(null);
  bridge.assetInfo.mockResolvedValue({
    name: "reference",
    extension: "png",
    width: 512,
    height: 512
  });
  bridge.post.mockResolvedValue({
    data: { asset: { id: "cloud-image" }, s3_url: "upload-url" }
  });
});

describe("prompt mirror attempt cancellation", () => {
  it("releases the caller but still drains source lookup IPC on library switch", async () => {
    const issued = deferred<void>();
    const lookup = deferred<unknown>();
    bridge.listAll.mockImplementation(() => {
      issued.resolve();
      return lookup.promise;
    });
    const { caller, library, result } = start("track");
    await issued.promise;
    caller.abort();
    await expect(result).rejects.toBe(caller.signal.reason);

    let drained = false;
    const acknowledgement = library.suspend().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    lookup.resolve([
      {
        id: "project",
        timelines: [
          {
            id: "shot",
            layers: [{ id: "track", clips: [{ asset_id: "video" }] }]
          }
        ]
      }
    ]);
    await acknowledgement;
    expect(bridge.getLink).not.toHaveBeenCalled();
    expect(bridge.post).not.toHaveBeenCalled();
  });

  it("aborts the reference registration transport and ignores a late response", async () => {
    const dispatched = deferred<AbortSignal>();
    const registration = deferred<unknown>();
    bridge.post.mockImplementationOnce((_url, _body, { signal }) => {
      dispatched.resolve(signal);
      return registration.promise;
    });
    const { caller, result } = start();
    const transportSignal = await dispatched.promise;
    caller.abort();
    expect(transportSignal.aborted).toBe(true);
    await expect(result).rejects.toBe(caller.signal.reason);
    registration.resolve({
      data: { asset: { id: "cloud-image" }, s3_url: "upload-url" }
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(bridge.uploadAsset).not.toHaveBeenCalled();
    expect(bridge.post).toHaveBeenCalledOnce();
  });

  it("does not drain a main-owned reference upload or publish its late link", async () => {
    const issued = deferred<void>();
    const upload = deferred<void>();
    bridge.uploadAsset.mockImplementation(() => {
      issued.resolve();
      return upload.promise;
    });
    const { caller, library, result } = start();
    await issued.promise;
    caller.abort();
    await expect(result).rejects.toBe(caller.signal.reason);
    await library.suspend();
    upload.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(bridge.putLink).not.toHaveBeenCalled();
    expect(bridge.post).toHaveBeenCalledOnce();
  });
});
