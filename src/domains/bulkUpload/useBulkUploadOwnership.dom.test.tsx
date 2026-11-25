import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { prepareLocalVideoImport } from "@/platform/prepareLocalVideoImport";
import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { useBulkUpload } from "./useBulkUpload.local";

vi.mock("@/platform/localDesktop", () => ({ isLocalApp: false }));
vi.mock("@/platform/prepareLocalVideoImport", () => ({
  prepareLocalVideoImport: vi.fn()
}));
vi.mock("@domains/project/useProject", () => ({ useProject: () => ({}) }));
vi.mock("@domains/project/shotFolders/usePlaceShotsInFolder", () => ({
  usePlaceShotsInFolder: () => ({ placeShotsInFolder: vi.fn() })
}));
vi.mock("@store/useToast", () => ({
  useToast: () => ({ showToast: vi.fn() })
}));
vi.mock("./useCloudBulkUpload", () => ({ useCloudBulkUpload: () => ({}) }));

const switchLibrary = async () => {
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
};

afterEach(async () => {
  cleanup();
  await switchLibrary();
  vi.unstubAllGlobals();
});

it("does not import a prepared video into a replacement library with the same project ID", async () => {
  const prepared = {
    sourcePath: "/fixture.mp4",
    name: "fixture.mp4",
    durationSeconds: 1,
    fps: 24,
    width: 100,
    height: 100,
    frameCount: 24,
    thumbnailDataUrl: "data:image/jpeg;base64,AA=="
  };
  const wait = Promise.withResolvers<typeof prepared>();
  const prepare = vi.mocked(prepareLocalVideoImport);
  prepare.mockReturnValueOnce(wait.promise).mockResolvedValueOnce(prepared);
  const importVideos = vi.fn().mockResolvedValue([]);
  vi.stubGlobal("mago", { projects: { importVideos } });
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <Provider>{children}</Provider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useBulkUpload("reused"), { wrapper });
  const oldStart = result.current.startBulkUpload;
  const files = [new File(["fixture"], "fixture.mp4")];
  let oldBatch!: Promise<void>;
  act(() => {
    oldBatch = oldStart(files, "reused", "");
  });
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce());

  await switchLibrary();
  expect(result.current.bulkUploadState.files).toEqual([]);
  await act(async () => {
    wait.resolve(prepared);
    await oldBatch;
    await oldStart(files, "reused", "");
  });
  expect(importVideos).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledOnce();

  await act(async () => {
    await result.current.startBulkUpload(files, "reused", "");
  });
  expect(importVideos).toHaveBeenCalledExactlyOnceWith({
    projectId: "reused",
    videos: [prepared]
  });
});
