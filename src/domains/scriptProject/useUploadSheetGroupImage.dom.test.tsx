import { IsReferenceImageUploadingProvider } from "@context/IsReferenceImageUploading";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useUploadSheetGroupImage } from "./useUploadSheetGroupImage";

const { addImage, reportFailure } = vi.hoisted(() => ({
  addImage: vi.fn(),
  reportFailure: vi.fn()
}));

vi.mock("@utils", () => ({
  getImageDimensions: vi.fn().mockResolvedValue({ width: 2, height: 1 }),
  resizeImageToFitWidth: (file: File) => Promise.resolve(file)
}));
vi.mock("./data/useAddSheetGroupImage", () => ({
  useAddSheetGroupImage: () => ({ mutateAsync: addImage, isPending: false })
}));
vi.mock("./useReportScriptProjectFailure", () => ({
  useReportScriptProjectFailure: () => reportFailure
}));

afterEach(() => {
  rendererLibrary.reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("drains an issued local import but does not publish or file it after teardown", async () => {
  const issued = Promise.withResolvers<void>();
  const imported = Promise.withResolvers<object>();
  const importImage = vi.fn(() => {
    issued.resolve();
    return imported.promise;
  });
  vi.stubGlobal("mago", {
    assets: { importImage },
    files: { getPath: () => "/fixture/portrait.png" }
  });
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <IsReferenceImageUploadingProvider>
        {children}
      </IsReferenceImageUploadingProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () => useUploadSheetGroupImage("same-project"),
    {
      wrapper
    }
  );
  const request = {
    timelineId: "same-timeline",
    token: "hero",
    file: new File(["fixture"], "portrait.png", { type: "image/png" })
  };
  const oldWork = rendererLibrary.capture();
  let oldUpload!: Promise<void>;
  await act(async () => {
    oldUpload = result.current.uploadSheetGroupImage(request, oldWork);
    await issued.promise;
  });
  const acknowledged = vi.fn();
  let suspension!: Promise<void>;
  act(() => {
    suspension = rendererLibrary.suspend().then(acknowledged);
  });
  expect(result.current.isUploadingSheetGroupImage).toBe(false);
  expect(acknowledged).not.toHaveBeenCalled();
  await act(async () => {
    imported.resolve({ id: "same-asset", filepath: "old-file" });
    await suspension;
    await oldUpload;
    rendererLibrary.reset();
  });
  expect(
    queryClient.getQueryData(queryKeys.imageAsset.byId("same-asset"))
  ).toBeUndefined();
  expect(addImage).not.toHaveBeenCalled();
  expect(reportFailure).not.toHaveBeenCalled();

  // Hold a filing request (e.g. an abort-ignoring transport) across a second
  // replacement. Its finally must not clear a newer upload for reused IDs.
  importImage.mockResolvedValue({ id: "same-asset", filepath: "new-file" });
  const oldFiling = Promise.withResolvers<void>();
  const nextFiling = Promise.withResolvers<void>();
  addImage
    .mockReturnValueOnce(oldFiling.promise)
    .mockReturnValueOnce(nextFiling.promise);
  let staleFiling!: Promise<void>;
  act(() => {
    staleFiling = result.current.uploadSheetGroupImage(request);
  });
  await waitFor(() => expect(addImage).toHaveBeenCalledTimes(1));
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
  let replacement!: Promise<void>;
  const replacementWork = rendererLibrary.capture();
  act(() => {
    replacement = result.current.uploadSheetGroupImage(
      request,
      replacementWork
    );
  });
  await waitFor(() => expect(addImage).toHaveBeenCalledTimes(2));
  expect(addImage).toHaveBeenLastCalledWith(
    expect.objectContaining({ assetId: "same-asset" }),
    replacementWork
  );
  await act(async () => {
    oldFiling.reject(new Error("old filing failed"));
    await staleFiling;
  });
  expect(result.current.isUploadingSheetGroupImage).toBe(true);
  expect(reportFailure).not.toHaveBeenCalled();
  await act(async () => {
    nextFiling.resolve();
    await replacement;
  });
  expect(result.current.isUploadingSheetGroupImage).toBe(false);
});
