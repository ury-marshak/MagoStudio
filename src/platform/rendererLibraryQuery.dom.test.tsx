import { useImageAsset } from "@domains/asset/useImageAsset";
import { useImageAssets } from "@domains/asset/useImageAssets";
import { useVideoAsset } from "@domains/asset/useVideoAsset";
import { useProject } from "@domains/project/useProject";
import { useProjectList } from "@domains/project/useProjectList";
import { useProjects } from "@domains/project/useProjects";
import { useTimelineList } from "@domains/project/useTimelineList";
import { useUpdateProject } from "@domains/project/useUpdateProject";
import { useInvalidateCachesWhenRendersEnd } from "@hooks/queue/useInvalidateCachesWhenRendersEnd";
import { useQueue } from "@hooks/queue/useQueue";
import { AssetStatus } from "@schemas/asset";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { queryKeys } from "@/queryKeys";

import { libraryQueryKey } from "./rendererLibraryQuery";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  token: vi.fn(),
  demand: vi.fn(() => () => {})
}));
vi.mock("@/platform/localDesktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/localDesktop")>()),
  isLocalApp: true
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get: mocks.get }
}));
vi.mock("@platform/identity", () => ({
  useUser: () => ({ user: undefined }),
  useAuth: () => ({ getToken: mocks.token })
}));
vi.mock(
  "@domains/asset/utils/mediaDownloadScheduler",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@domains/asset/utils/mediaDownloadScheduler")
    >()),
    mediaDownloads: { demand: mocks.demand }
  })
);

const PROJECT = "same-project";
const SHOT = "same-shot";
const IMAGE = "same-image";
const BATCH_IMAGE = "same-batch-image";
const VIDEO = "same-video";
const DATE = "2026-11-25T00:00:00.000Z";
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const project = (library: string) => ({
  id: PROJECT,
  name: library,
  description: null,
  active: true,
  settings: {},
  timelines: [],
  type: "timeline",
  created_at: DATE,
  updated_at: DATE
});
const listRow = (library: string) => ({
  ...project(library),
  total_renders: 0,
  total_img2img: 0,
  timeline_count: 1,
  preview_url: null
});
const shotRow = (library: string) => ({
  ...listRow(library),
  id: SHOT,
  preview_url: `${library}-thumbnail`
});
const asset = (id: string, library: string) => ({
  id,
  filepath: `mago-media://asset/${id}`,
  data: { library }
});
const queueRow = (
  id: string,
  library: string,
  status = AssetStatus.PENDING
) => ({
  id,
  asset_id: VIDEO,
  project_id: PROJECT,
  status,
  project_name: library
});

type Asset = ReturnType<typeof asset>;
type Row = ReturnType<typeof queueRow>;
let library: "A" | "B";
let willChange: () => Promise<void>;
let didChange: () => void;
const projectGet = vi.fn(async () => project(library));
const projectList = vi.fn(async () => [
  listRow(library),
  { ...listRow(library), id: "another-project" }
]);
const localImages = vi.fn<() => Promise<Row[]>>();
const cloudHistory = vi.fn<() => Promise<Row[]>>();
const assetGet = vi.fn<(id: string) => Promise<Asset | null>>();
const bridge = {
  account: { mode: "cloud" },
  library: {
    onWillChange: async (fn: typeof willChange) => {
      willChange = fn;
    },
    onDidChange: (fn: typeof didChange) => {
      didChange = fn;
    }
  },
  projects: {
    get: projectGet,
    update: vi.fn(async () => {}),
    list: projectList,
    listAll: async () => [project(library)],
    listShots: async () => [shotRow(library)]
  },
  assets: { get: assetGet },
  imageRenders: { listQueue: localImages },
  cloud: { renders: { listQueue: cloudHistory } }
};

const setup = (defaults?: ConstructorParameters<typeof QueryClient>[0]) => {
  const client = new QueryClient(
    defaults ?? { defaultOptions: { queries: { retry: false } } }
  );
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

const switchLibrary = async () => {
  await act(async () => {
    await willChange();
  });
  library = "B";
  await act(async () => {
    didChange();
  });
};

beforeEach(() => {
  library = "A";
  vi.stubGlobal("mago", bridge);
  projectGet.mockClear();
  projectList.mockClear();
  assetGet.mockReset().mockImplementation(async (id) => asset(id, library));
  localImages
    .mockReset()
    .mockImplementation(async () => [queueRow("local", library)]);
  cloudHistory
    .mockReset()
    .mockImplementation(async () => [queueRow("history", library)]);
  mocks.get
    .mockReset()
    .mockImplementation(async () => ({ data: [queueRow("remote", library)] }));
  mocks.token.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("isolates resolved projects, lists, timelines and individual assets in a single mounted client", async () => {
  const { client, wrapper } = setup();
  const originalKey = libraryQueryKey(queryKeys.project.byId(PROJECT));
  const { result } = renderHook(
    () => ({
      project: useProject(PROJECT).data?.name,
      list: useProjectList().allItems[0]?.name,
      projects: useProjects().data?.[0]?.name,
      timeline: useTimelineList(PROJECT).thumbnailUrlById[SHOT],
      image: useImageAsset({ assetId: IMAGE }).data?.asset?.data,
      video: useVideoAsset({ assetId: VIDEO }).data
    }),
    { wrapper }
  );
  const expectLibrary = (name: string) =>
    expect(result.current).toMatchObject({
      project: name,
      list: name,
      projects: name,
      timeline: `${name}-thumbnail`,
      image: { library: name },
      video: { asset: { data: { library: name } } }
    });
  await waitFor(() => expectLibrary("A"));
  await act(async () => {
    await willChange();
  });
  expect(result.current).toMatchObject({
    project: undefined,
    list: undefined,
    projects: undefined,
    timeline: undefined,
    image: undefined,
    video: undefined
  });
  library = "B";
  await act(async () => {
    didChange();
  });
  await waitFor(() => expectLibrary("B"));

  expect(client.getQueryData(originalKey)).toMatchObject({ name: "A" });
  expect(
    client.getQueryData(libraryQueryKey(queryKeys.project.byId(PROJECT)))
  ).toMatchObject({ name: "B" });
  await act(async () => {
    await client.invalidateQueries({
      queryKey: queryKeys.project.byId(PROJECT)
    });
  });
  expect(projectGet).toHaveBeenCalledTimes(3);
});

it("does not publish a late image batch member into either cache epoch", async () => {
  const hold = deferred<Asset>();
  assetGet.mockImplementationOnce(() => hold.promise);
  const aKey = libraryQueryKey(queryKeys.imageAsset.byId(BATCH_IMAGE));
  const batchA = libraryQueryKey(
    queryKeys.imageAssetBatch.forIds([BATCH_IMAGE])
  );
  const { client, wrapper } = setup();
  const { result } = renderHook(
    () => useImageAssets({ assetIds: [BATCH_IMAGE] }),
    { wrapper }
  );
  await waitFor(() => expect(assetGet).toHaveBeenCalledWith(BATCH_IMAGE));
  await switchLibrary();
  await waitFor(() =>
    expect(result.current.data[0]?.asset?.data).toMatchObject({ library: "B" })
  );
  await act(async () => {
    hold.resolve(asset(BATCH_IMAGE, "A"));
    await hold.promise;
  });
  await waitFor(() =>
    expect(client.getQueryState(batchA)?.fetchStatus).toBe("idle")
  );
  expect(client.getQueryData(aKey)).toBeUndefined();
  expect(
    client.getQueryData(libraryQueryKey(queryKeys.imageAsset.byId(BATCH_IMAGE)))
  ).toMatchObject({ asset: { data: { library: "B" } } });
});

it("does not start a cloud queue read from a local image list that resolves after replacement", async () => {
  const hold = deferred<Row[]>();
  localImages.mockImplementationOnce(() => hold.promise);
  const { wrapper } = setup();
  const { result } = renderHook(() => useQueue(), { wrapper });
  await waitFor(() => expect(localImages).toHaveBeenCalledOnce());
  await switchLibrary();
  await waitFor(() => expect(result.current.data).toHaveLength(3));
  await act(async () => {
    hold.resolve([queueRow("local", "A")]);
    await hold.promise;
  });
  expect(cloudHistory).toHaveBeenCalledOnce();
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(result.current.data?.map((row) => row.project_name)).toEqual([
    "B",
    "B",
    "B"
  ]);
});

it("ignores a late remote poll, primes fresh count and end baselines, and still invalidates on B's completion", async () => {
  const { client, wrapper } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(
    () => {
      useInvalidateCachesWhenRendersEnd();
      return useQueue();
    },
    { wrapper }
  );
  await waitFor(() => expect(result.current.data).toHaveLength(3));
  const staleTrigger = result.current.triggerRefetch;
  const staleRefetch = result.current.refetch;
  const lateRemote = deferred<{ data: Row[] }>();
  mocks.get.mockImplementationOnce(() => lateRemote.promise);
  await act(async () => {
    staleTrigger();
  });
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  const oldSignal = mocks.get.mock.lastCall?.[1].signal as AbortSignal;
  localImages.mockResolvedValueOnce([
    queueRow("local", "B", AssetStatus.FINISHED)
  ]);
  await switchLibrary();
  await waitFor(() =>
    expect(result.current.data?.map((row) => row.project_name)).toEqual([
      "B",
      "B",
      "B"
    ])
  );
  expect(oldSignal.aborted).toBe(true);
  await expect(staleRefetch()).rejects.toMatchObject({ name: "AbortError" });
  expect(invalidate).not.toHaveBeenCalled();

  await act(async () => {
    staleTrigger();
    lateRemote.resolve({ data: [queueRow("remote", "A", AssetStatus.ERROR)] });
    await lateRemote.promise;
  });
  expect(mocks.get).toHaveBeenCalledTimes(3);
  expect(invalidate).not.toHaveBeenCalled();
  expect(result.current.data?.map((row) => row.project_name)).toEqual([
    "B",
    "B",
    "B"
  ]);

  localImages.mockResolvedValueOnce([
    queueRow("local", "B", AssetStatus.FINISHED)
  ]);
  cloudHistory.mockResolvedValueOnce([
    queueRow("history", "B", AssetStatus.FINISHED)
  ]);
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.projectCut.all
    })
  );
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: queryKeys.videoAsset.all
  });
});

it("does not retarget a scheduled failed poll retry to B", async () => {
  const retryDelay = vi.fn(() => 1000);
  const { wrapper } = setup({
    defaultOptions: { queries: { retry: 2, retryDelay } }
  });
  localImages.mockRejectedValueOnce(new Error("A's local read failed"));
  const { result } = renderHook(() => useQueue(), { wrapper });
  await waitFor(() => expect(retryDelay).toHaveBeenCalledOnce());
  await switchLibrary();
  await waitFor(() => expect(result.current.data?.[0]?.project_name).toBe("B"));
  // Let the delay expire to exercise TanStack's actual retry callback.
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(localImages).toHaveBeenCalledTimes(2);
  expect(mocks.get).toHaveBeenCalledOnce();
});

it("does not dispatch a fallback video read after an old token lookup", async () => {
  const token = deferred<string>();
  mocks.token.mockReturnValueOnce(token.promise);
  assetGet.mockResolvedValueOnce(null);
  const { client, wrapper } = setup();
  const originalKey = libraryQueryKey(queryKeys.videoAsset.byId(VIDEO));
  const { result } = renderHook(() => useVideoAsset({ assetId: VIDEO }), {
    wrapper
  });
  await waitFor(() => expect(mocks.token).toHaveBeenCalledOnce());
  await switchLibrary();
  await waitFor(() =>
    expect(result.current.data).toMatchObject({
      asset: { data: { library: "B" } }
    })
  );
  await act(async () => {
    token.resolve("token-A");
    await token.promise;
  });
  await waitFor(() =>
    expect(client.getQueryState(originalKey)?.fetchStatus).toBe("idle")
  );
  expect(mocks.get).not.toHaveBeenCalled();
});

it("rejects a delayed project cache writer after reset and updates both current keys for a B write", async () => {
  const hold = deferred<void>();
  const beforeSuccess = vi.fn().mockReturnValueOnce(hold.promise);
  const { client, wrapper } = setup({
    mutationCache: new MutationCache({ onSuccess: beforeSuccess })
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(
    () => ({
      detail: useProject(PROJECT),
      list: useProjects(),
      update: useUpdateProject()
    }),
    { wrapper }
  );
  const variables = (name: string) => ({
    projectId: PROJECT,
    projectName: name,
    projectDescription: null,
    settingsPatch: {}
  });
  await waitFor(() => expect(result.current.detail.data?.name).toBe("A"));
  let stale!: Promise<unknown>;
  await act(async () => {
    stale = result.current.update
      .mutateAsync(variables("renamed A"))
      .catch((error: unknown) => error);
  });
  await waitFor(() => expect(beforeSuccess).toHaveBeenCalledOnce());
  await switchLibrary();
  await waitFor(() => expect(result.current.list.data?.[0]?.name).toBe("B"));
  await act(async () => {
    hold.resolve();
    await stale;
  });
  expect(await stale).toMatchObject({ name: "AbortError" });
  expect(invalidate).not.toHaveBeenCalled();
  expect(result.current.detail.data?.name).toBe("B");

  await act(async () => {
    await result.current.update.mutateAsync(variables("renamed B"));
  });
  expect(
    client.getQueryData(libraryQueryKey(queryKeys.project.byId(PROJECT)))
  ).toMatchObject({ name: "renamed B" });
  expect(
    client.getQueryData(libraryQueryKey(queryKeys.projects.all))
  ).toMatchObject([{ name: "renamed B" }]);
});

it("does not let a previous library's pagination callback fetch B's next page", async () => {
  const { wrapper } = setup();
  const { result } = renderHook(() => useProjectList({ perPage: 1 }), {
    wrapper
  });
  await waitFor(() => expect(result.current.hasNextPage).toBe(true));
  const oldNextPage = result.current.fetchNextPage;
  await switchLibrary();
  await waitFor(() => expect(result.current.allItems[0]?.name).toBe("B"));
  await expect(oldNextPage()).resolves.toBeUndefined();
  expect(projectList).toHaveBeenCalledTimes(2);
  await act(async () => {
    await result.current.fetchNextPage();
  });
  await waitFor(() =>
    expect(result.current.allItems.map((item) => item.name)).toEqual(["B", "B"])
  );
});
