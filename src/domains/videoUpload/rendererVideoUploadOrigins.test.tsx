import { renderHook, act } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ChangeEvent, PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { useCloudBulkUpload } from "../bulkUpload/useCloudBulkUpload";
import { useCreateProjectAndUploadVideo } from "../shot/useCreateProjectAndUploadVideo";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  fetch: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  rename: vi.fn(),
  createTimeline: vi.fn(),
  deleteTimeline: vi.fn(),
  renameTimeline: vi.fn(),
  validate: vi.fn(),
  updateFolders: vi.fn(),
  showToast: vi.fn()
}));
vi.mock("./useIngestVideo", () => ({
  useIngestVideo: () => ({ ingestVideo: mocks.ingest })
}));
vi.mock("../project/fetchProject", () => ({ fetchProject: mocks.fetch }));
vi.mock("../project/useAutoNameProjectFromVideo", () => ({
  useAutoNameProjectFromVideo: () => ({
    autoNameProjectFromVideo: mocks.rename
  })
}));
vi.mock("../project/useCreateNewProject", () => ({
  useCreateNewProject: () => ({ createNewProject: mocks.createProject })
}));
vi.mock("../project/useDeleteProject", () => ({
  useDeleteProject: () => ({ mutateAsync: mocks.deleteProject })
}));
vi.mock("../shot/api/postTimeline", () => ({
  postTimeline: mocks.createTimeline
}));
vi.mock("../shot/api/putTimeline", () => ({
  putTimeline: mocks.renameTimeline
}));
vi.mock("../shot/api/deleteTimeline", () => ({
  deleteTimeline: mocks.deleteTimeline
}));
vi.mock("../project/shotFolders/useProjectShotFolders", () => ({
  useProjectShotFolders: () => ({ data: null })
}));
vi.mock("../project/shotFolders/useUpdateProjectShotFolders", () => ({
  useUpdateProjectShotFolders: () => ({ mutateAsync: mocks.updateFolders })
}));
vi.mock("../bulkUpload/utils/getVideoDuration", () => ({
  validateVideoFile: mocks.validate
}));
vi.mock("@hooks/tracking/trackingUtils", () => ({
  trackingUtils: { videoActions: { upload: vi.fn() } }
}));
vi.mock("@store/useToast", () => ({
  useToast: () => ({ showToast: mocks.showToast })
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const project = {
  id: "same-project",
  timelines: [{ id: "same-shot", layers: [] }]
};
const file = new File(["video"], "video.mp4", { type: "video/mp4" });
const event = {
  target: { files: [file] }
} as unknown as ChangeEvent<HTMLInputElement>;

beforeEach(() => {
  vi.resetAllMocks();
  rendererLibrary.reset();
  mocks.fetch.mockResolvedValue(project);
  mocks.createProject.mockResolvedValue(project);
  mocks.ingest.mockResolvedValue({
    outcome: "ingested",
    assetId: "same-asset"
  });
});

afterEach(async () => {
  await act(() => rendererLibrary.suspend());
});

const switchLibrary = async () =>
  act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });

it("binds project upload before looking up the existing empty timeline", async () => {
  const oldProject = Promise.withResolvers<typeof project>();
  mocks.fetch.mockReturnValueOnce(oldProject.promise);
  const onSuccess = vi.fn();
  const { result } = renderHook(() =>
    useCreateProjectAndUploadVideo({ existingProjectId: project.id, onSuccess })
  );
  let old!: Promise<void>;
  await act(async () => {
    old = result.current.handleUpload({ e: event });
  });
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
  const origin = mocks.fetch.mock.calls[0][1];
  await switchLibrary();
  expect(result.current.isUploading).toBe(false);
  await act(() => result.current.handleUpload({ e: event }));
  const replacement = mocks.fetch.mock.calls[1][1];
  expect(mocks.renameTimeline).toHaveBeenCalledExactlyOnceWith(
    "same-shot",
    expect.any(Object),
    replacement
  );
  expect(mocks.ingest).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ projectId: project.id }),
    replacement
  );
  expect(replacement.signal).not.toBe(origin.signal);
  await act(async () => {
    oldProject.resolve(project);
    await old;
  });
  expect(mocks.renameTimeline).toHaveBeenCalledOnce();
  expect(mocks.ingest).toHaveBeenCalledOnce();
  expect(onSuccess).toHaveBeenCalledExactlyOnceWith(project.id, "same-shot");
  expect(mocks.deleteProject).not.toHaveBeenCalled();
});

it("does not clean up the replacement's reused project when old ingestion fails", async () => {
  const failedIngestion = Promise.withResolvers<never>();
  mocks.ingest.mockReturnValueOnce(failedIngestion.promise);
  const onSuccess = vi.fn();
  const { result } = renderHook(() =>
    useCreateProjectAndUploadVideo({ onSuccess })
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleUpload({ e: event });
  });
  expect(mocks.createProject).toHaveBeenCalledWith(
    expect.any(Object),
    mocks.ingest.mock.calls[0][1]
  );
  await switchLibrary();
  await act(async () => {
    failedIngestion.reject(new Error("Old upload failed"));
    await pending;
  });
  expect(mocks.deleteProject).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
  expect(result.current.error).toBeNull();
});

it("does not let a bulk batch's old validation or finally update the next batch", async () => {
  const oldValidation = Promise.withResolvers<string | null>();
  const newValidation = Promise.withResolvers<string | null>();
  mocks.validate
    .mockReturnValueOnce(oldValidation.promise)
    .mockReturnValueOnce(newValidation.promise);
  const store = createStore();
  const { result } = renderHook(() => useCloudBulkUpload(project.id), {
    wrapper: ({ children }: PropsWithChildren) => (
      <Provider store={store}>{children}</Provider>
    )
  });
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.startBulkUpload([file], project.id, "folder");
  });
  expect(mocks.validate).toHaveBeenCalledOnce();
  await switchLibrary();
  let replacement!: Promise<void>;
  await act(async () => {
    replacement = result.current.startBulkUpload(
      [file],
      project.id,
      "replacement-folder"
    );
  });
  expect(mocks.validate).toHaveBeenCalledTimes(2);
  const active = result.current.bulkUploadState;
  expect(active.isUploadInProgress).toBe(true);
  await act(async () => {
    oldValidation.resolve(null);
    await pending;
  });
  expect(result.current.bulkUploadState).toEqual(active);
  expect(mocks.renameTimeline).not.toHaveBeenCalled();
  expect(mocks.ingest).not.toHaveBeenCalled();
  expect(mocks.showToast).not.toHaveBeenCalled();
  await act(async () => {
    newValidation.resolve(null);
    await replacement;
  });
  const work = mocks.fetch.mock.calls[1][1];
  expect(mocks.updateFolders).toHaveBeenCalledExactlyOnceWith(
    expect.any(Array),
    work
  );
  expect(mocks.ingest).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ awaitInvalidation: false }),
    work
  );
  expect(mocks.showToast).toHaveBeenCalledOnce();
  expect(result.current.bulkUploadState.files[0].status).toBe("completed");
});
