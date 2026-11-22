import { VideoEngine } from "@models/video/types";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { useCloudAdaptableI2vPromptFromLocal } from "./useCloudAdaptableI2vPromptFromLocal";

const cloud = vi.hoisted(() => ({
  hasExternalText: vi.fn(),
  resolveSourceVideoContext: vi.fn(),
  mirrorReferences: vi.fn(),
  adaptOnCloud: vi.fn(),
  markCloudAssetLinkStale: vi.fn(),
  showToast: vi.fn(),
  hideToast: vi.fn(),
  updateToast: vi.fn()
}));

vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: false,
  getLocalDesktopApi: () => ({
    vlm: { hasExternalText: cloud.hasExternalText }
  })
}));
vi.mock("@store/useToast", () => ({
  useToast: () => ({
    showToast: cloud.showToast,
    hideToast: cloud.hideToast,
    updateToast: cloud.updateToast
  })
}));
vi.mock("./api/markCloudAssetLinkStale", () => ({
  markCloudAssetLinkStale: cloud.markCloudAssetLinkStale
}));
vi.mock("./api/mirrorAdaptPromptReferencesToCloud", () => ({
  resolveMirroredSourceVideoContext: cloud.resolveSourceVideoContext,
  mirrorAdaptPromptReferencesToCloud: cloud.mirrorReferences
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { post: cloud.adaptOnCloud }
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const missingId = "11111111-1111-1111-1111-111111111111";
const missingReference = new Error(`reference asset ${missingId} not found`);
const adaptation = { data: { adapted: true, adapted_prompt: "adapted" } };
const sourceVideoContext = {
  localAssetId: "same-asset",
  cloudSourceVideoLinkLocalId: "same-asset#shot-same-shot#trim-full",
  cloudAssetId: missingId,
  cloudProjectId: "same-cloud-project"
};
const renderSubject = () => {
  const onChange = vi.fn();
  return {
    onChange,
    ...renderHook(
      ({ value }) =>
        useCloudAdaptableI2vPromptFromLocal({
          value,
          onChange,
          sourceVideoTrackId: "same-track",
          referenceImageAssetIds: [],
          cloudEngine: VideoEngine.minimax_reference
        }),
      { initialProps: { value: "original" } }
    )
  };
};

const switchLibrary = async () => {
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
};

beforeEach(() => {
  rendererLibrary.reset();
  vi.resetAllMocks();
  cloud.hasExternalText.mockResolvedValue(false);
  cloud.resolveSourceVideoContext.mockResolvedValue(sourceVideoContext);
  cloud.mirrorReferences.mockResolvedValue([
    { localAssetId: sourceVideoContext.localAssetId, cloudAssetId: missingId }
  ]);
  cloud.adaptOnCloud.mockResolvedValue(adaptation);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("useCloudAdaptableI2vPromptFromLocal", () => {
  it("blocks cloud reference mirroring when external text is configured", async () => {
    cloud.hasExternalText.mockResolvedValue(true);
    const { result } = renderSubject();
    await act(async () => {
      await result.current.adaptPrompt();
    });
    expect(cloud.resolveSourceVideoContext).not.toHaveBeenCalled();
    expect(cloud.mirrorReferences).not.toHaveBeenCalled();
    expect(cloud.adaptOnCloud).not.toHaveBeenCalled();
    expect(cloud.showToast).toHaveBeenCalledOnce();
  });

  it("does not list source tracks after switching during readiness", async () => {
    const readiness = deferred<boolean>();
    cloud.hasExternalText.mockReturnValueOnce(readiness.promise);
    const { result, onChange } = renderSubject();
    let old!: Promise<void>;
    await act(async () => {
      old = result.current.adaptPrompt();
    });
    expect(cloud.hasExternalText).toHaveBeenCalledOnce();
    expect(result.current.isAdaptingPrompt).toBe(true);
    await switchLibrary();
    await act(async () => {
      readiness.resolve(false);
      await old;
    });
    expect(result.current.isAdaptingPrompt).toBe(false);
    expect(cloud.resolveSourceVideoContext).not.toHaveBeenCalled();
    expect(cloud.mirrorReferences).not.toHaveBeenCalled();
    expect(cloud.adaptOnCloud).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(cloud.showToast).not.toHaveBeenCalled();
  });

  it("keeps the source link retry for live work", async () => {
    cloud.adaptOnCloud.mockRejectedValueOnce(missingReference);
    const { result, onChange } = renderSubject();
    await act(async () => {
      await result.current.adaptPrompt();
    });
    expect(cloud.markCloudAssetLinkStale.mock.calls[0]?.[0]).toBe(
      sourceVideoContext.cloudSourceVideoLinkLocalId
    );
    expect(cloud.resolveSourceVideoContext).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith("adapted");
  });

  it("does not retry or settle after a stale missing-reference response", async () => {
    const response = deferred<typeof adaptation>();
    cloud.adaptOnCloud.mockReturnValueOnce(response.promise);
    const { result, onChange } = renderSubject();
    let old!: Promise<void>;
    await act(async () => {
      old = result.current.adaptPrompt();
    });
    expect(cloud.adaptOnCloud).toHaveBeenCalledOnce();
    await switchLibrary();
    await act(async () => {
      response.reject(missingReference);
      await old;
    });
    expect(cloud.markCloudAssetLinkStale).not.toHaveBeenCalled();
    expect(cloud.resolveSourceVideoContext).toHaveBeenCalledOnce();
    expect(cloud.mirrorReferences).toHaveBeenCalledOnce();
    expect(cloud.adaptOnCloud).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(cloud.showToast).not.toHaveBeenCalled();
    expect(result.current.canUndoAdaptPrompt).toBe(false);
  });

  it("dismisses only the unmounted editor's progress before mirroring finishes", async () => {
    const stalledMirror = deferred<typeof sourceVideoContext>();
    cloud.resolveSourceVideoContext.mockImplementationOnce(({ onProgress }) => {
      onProgress("uploading");
      return stalledMirror.promise;
    });
    cloud.showToast.mockReturnValue("old-toast");
    const { result, unmount, onChange } = renderSubject();
    let old!: Promise<void>;
    await act(async () => {
      old = result.current.adaptPrompt();
    });
    const work = cloud.resolveSourceVideoContext.mock.calls[0]?.[1];
    unmount();
    expect(work.signal.aborted).toBe(true);
    expect(cloud.hideToast).toHaveBeenCalledExactlyOnceWith("old-toast");
    await old;
    await act(async () => {
      stalledMirror.reject(new Error("late upload error"));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(cloud.showToast).toHaveBeenCalledOnce();
    expect(cloud.mirrorReferences).not.toHaveBeenCalled();
  });

  it.each(["library switch", "editor edit"] as const)(
    "isolates a replacement after %s",
    async (change) => {
      const oldResponse = deferred<typeof adaptation>();
      const newResponse = deferred<typeof adaptation>();
      cloud.adaptOnCloud
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(newResponse.promise);
      cloud.resolveSourceVideoContext.mockImplementation(
        async ({ onProgress }) => {
          onProgress("uploading");
          return sourceVideoContext;
        }
      );
      cloud.showToast
        .mockReturnValueOnce("old-toast")
        .mockReturnValueOnce("new-toast");
      const { result, rerender, onChange } = renderSubject();
      let old!: Promise<void>;
      let current!: Promise<void>;
      await act(async () => {
        old = result.current.adaptPrompt();
      });
      if (change === "library switch") await switchLibrary();
      else rerender({ value: "manually edited" });
      expect(result.current.isAdaptingPrompt).toBe(false);
      await old;
      expect(cloud.hideToast).toHaveBeenCalledExactlyOnceWith("old-toast");
      await act(async () => {
        current = result.current.adaptPrompt();
      });
      cloud.resolveSourceVideoContext.mock.calls[0]?.[0].onProgress(
        "ingesting"
      );
      expect(cloud.updateToast).not.toHaveBeenCalled();
      await act(async () => {
        oldResponse.resolve({
          data: { adapted: false, adapted_prompt: "stale" }
        });
      });
      expect(result.current.isAdaptingPrompt).toBe(true);
      expect(cloud.hideToast).toHaveBeenCalledExactlyOnceWith("old-toast");
      expect(cloud.showToast).toHaveBeenCalledTimes(2);
      expect(onChange).not.toHaveBeenCalled();
      await act(async () => {
        newResponse.resolve(adaptation);
        await current;
      });
      expect(result.current.isAdaptingPrompt).toBe(false);
      expect(onChange).toHaveBeenCalledExactlyOnceWith("adapted");
      expect(cloud.hideToast.mock.calls).toEqual([
        ["old-toast"],
        ["new-toast"]
      ]);
      rerender({ value: "adapted" });
      expect(result.current.canUndoAdaptPrompt).toBe(true);
      await switchLibrary();
      expect(result.current.canUndoAdaptPrompt).toBe(false);
    }
  );
});
