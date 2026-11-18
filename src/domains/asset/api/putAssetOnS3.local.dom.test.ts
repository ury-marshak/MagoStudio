import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadAssetToS3 } from "./putAssetOnS3.local";

type ProgressListener = (event: { assetId: string; fraction: number }) => void;

const stubCloud = () => {
  let listener: ProgressListener = () => {};
  const unsubscribe = vi.fn();
  const cloud = {
    uploadBytes: vi.fn(async (input: { uploadId: string }) => {
      listener({ assetId: "someone-else", fraction: 0.9 });
      listener({ assetId: input.uploadId, fraction: 0.5 });
      listener({ assetId: input.uploadId, fraction: 1 });
    }),
    cancelUploadBytes: vi.fn().mockResolvedValue(undefined),
    onUploadProgress: vi.fn((next: ProgressListener) => {
      listener = next;
      return unsubscribe;
    })
  };
  vi.stubGlobal("mago", { cloud });
  return { cloud, unsubscribe };
};

describe("uploadAssetToS3 (desktop)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the file to the main process instead of PUTting from the page", async () => {
    const { cloud, unsubscribe } = stubCloud();
    const progress: number[] = [];

    await uploadAssetToS3({
      s3_url: "https://bucket.example/upload?sig=1",
      file: new File(["video"], "a.mp4", { type: "video/mp4" }),
      onUploadProgress: (value) => progress.push(value)
    });

    expect(cloud.uploadBytes).toHaveBeenCalledWith({
      uploadId: expect.any(String),
      presignedUrl: "https://bucket.example/upload?sig=1",
      contentType: "video/mp4",
      bytes: expect.any(ArrayBuffer)
    });
    expect(progress).toEqual([50, 100]);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("does not start an upload whose signal is already aborted", async () => {
    const { cloud } = stubCloud();
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadAssetToS3({
        s3_url: "https://bucket.example/upload",
        file: new File(["video"], "a.mp4", { type: "video/mp4" }),
        signal: controller.signal
      })
    ).rejects.toThrow();
    expect(cloud.uploadBytes).not.toHaveBeenCalled();
  });

  it("does not dispatch a PUT or cancellation for a file read aborted before IPC", async () => {
    const { cloud } = stubCloud();
    const controller = new AbortController();
    const file = new File(["video"], "a.mp4");
    const bytes = Promise.withResolvers<ArrayBuffer>();
    vi.spyOn(file, "arrayBuffer").mockReturnValue(bytes.promise);
    const rejected = expect(
      uploadAssetToS3({
        s3_url: "https://bucket.example/upload",
        file,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    bytes.resolve(new ArrayBuffer(5));
    await rejected;
    expect(cloud.uploadBytes).not.toHaveBeenCalled();
    expect(cloud.cancelUploadBytes).not.toHaveBeenCalled();
  });

  it("suppresses cancelled progress and awaits the cancellation acknowledgement", async () => {
    const { cloud, unsubscribe } = stubCloud();
    const controller = new AbortController();
    const acknowledgement = Promise.withResolvers<void>();
    cloud.cancelUploadBytes.mockReturnValue(acknowledgement.promise);
    const onUploadProgress = vi.fn();
    const upload = cloud.uploadBytes.getMockImplementation()!;
    cloud.uploadBytes.mockImplementationOnce(async (input) => {
      controller.abort();
      await upload(input);
    });
    const settled = vi.fn();
    const rejected = expect(
      uploadAssetToS3({
        s3_url: "https://bucket.example/upload",
        file: new File(["video"], "a.mp4"),
        signal: controller.signal,
        onUploadProgress
      }).finally(settled)
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    expect(onUploadProgress).not.toHaveBeenCalled();
    expect(cloud.cancelUploadBytes).toHaveBeenCalledExactlyOnceWith(
      cloud.uploadBytes.mock.calls[0][0].uploadId
    );
    acknowledgement.reject(new Error("main job already suspended"));
    await rejected;
  });
});
