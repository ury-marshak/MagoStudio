import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { getProjectCut } from "./api/getProjectCut.local";
import { postProjectCutExport } from "./api/postProjectCutExport.local";
import { useProjectCut } from "./data/useProjectCut";
import { useProjectCutExportDryRun } from "./data/useProjectCutExportDryRun";
import { useExportCut } from "./useExportCut";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  fetchMedia: vi.fn(),
  download: vi.fn(),
  zip: vi.fn()
}));
vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get: mocks.get, post: mocks.post }
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => window.mago
}));
vi.mock("@/platform/rendererMediaAccess", () => ({
  fetchRendererMedia: mocks.fetchMedia
}));
vi.mock("@hooks/files/utils", () => ({ triggerBlobDownload: mocks.download }));
vi.mock("@domains/project/useProject", () => ({ useProject: () => ({}) }));
vi.mock("./useDownloadCut", () => ({
  useDownloadCut: () => ({
    downloadCut: mocks.zip,
    downloadableShotCount: 1,
    isDownloadingCut: false
  })
}));

const projectId = "reused-project";
const planId = "reused-plan";
const url = "mago-media://script-project/reused-video";
const cut = (sequence: number) => ({
  project_id: projectId,
  missing: [sequence]
});
const bridge = (origin: "local" | "cloud", sequence?: number) => {
  const scriptProjects = {
    get: vi
      .fn()
      .mockResolvedValue(
        sequence === undefined ? null : { cut: cut(sequence) }
      ),
    put: vi.fn().mockResolvedValue(undefined),
    exportCut: vi.fn().mockResolvedValue({ would_export: [sequence] })
  };
  const projects = { get: vi.fn().mockResolvedValue({ origin }) };
  vi.stubGlobal("mago", {
    account: { mode: "cloud" },
    library: { onWillChange: async () => {}, onDidChange: () => {} },
    projects,
    scriptProjects
  });
  return { projects, scriptProjects };
};
const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(async () => {
  await rendererLibrary.suspend();
  rendererLibrary.reset();
  vi.unstubAllGlobals();
});

it("keeps cut and dry-run cache entries apart and drops late cloud refreshes for reused IDs", async () => {
  const a = bridge("cloud", 1);
  const oldCut = Promise.withResolvers<{ data: unknown }>();
  const oldDryRun = Promise.withResolvers<{ data: unknown }>();
  mocks.post
    .mockResolvedValueOnce({ data: { would_export: [1] } })
    .mockReturnValueOnce(oldDryRun.promise);
  mocks.get.mockReturnValueOnce(oldCut.promise);
  const { client, wrapper } = setup();
  const { result } = renderHook(
    () => ({
      cut: useProjectCut(projectId).data,
      dryRun: useProjectCutExportDryRun(projectId).data
    }),
    { wrapper }
  );
  await waitFor(() => {
    expect(result.current.cut?.missing).toEqual([1]);
    expect(result.current.dryRun?.would_export).toEqual([1]);
  });
  let refresh!: Promise<void>;
  act(() => {
    refresh = client.invalidateQueries({
      queryKey: queryKeys.projectCut.byProjectId(projectId)
    });
  });
  await waitFor(() => {
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  let b!: ReturnType<typeof bridge>;
  await act(async () => {
    // Neither outstanding HTTP call participates in the drain.
    await rendererLibrary.suspend();
    b = bridge("local", 2);
    rendererLibrary.reset();
  });
  expect(result.current.cut?.missing).not.toEqual([1]);
  expect(result.current.dryRun?.would_export).not.toEqual([1]);
  await waitFor(() => {
    expect(result.current.cut?.missing).toEqual([2]);
    expect(result.current.dryRun?.would_export).toEqual([2]);
  });
  await act(async () => {
    oldCut.resolve({ data: cut(3) });
    oldDryRun.resolve({ data: { would_export: [3] } });
    await refresh;
  });
  expect(a.scriptProjects.put).not.toHaveBeenCalled();
  expect(b.scriptProjects.put).not.toHaveBeenCalled();
  expect(result.current.cut?.missing).toEqual([2]);
  expect(result.current.dryRun?.would_export).toEqual([2]);
});

it("drains an issued snapshot commit and does not fall back to the retired cached cut", async () => {
  const { scriptProjects } = bridge("cloud", 1);
  const commit = Promise.withResolvers<void>();
  scriptProjects.put.mockReturnValueOnce(commit.promise);
  mocks.get.mockResolvedValueOnce({ data: cut(3) });
  const request = getProjectCut(projectId, { preferCache: false });
  const stopped = expect(request).rejects.toMatchObject({ name: "AbortError" });
  await waitFor(() => expect(scriptProjects.put).toHaveBeenCalledOnce());
  const drained = vi.fn();
  const suspend = rendererLibrary.suspend().then(drained);
  await Promise.resolve();
  expect(drained).not.toHaveBeenCalled();
  commit.resolve();
  await suspend;
  await stopped;
  expect(scriptProjects.get).toHaveBeenCalledOnce();
});

it("drains the export origin lookup but never dispatches an old export into a replacement library", async () => {
  const a = bridge("local");
  const lookup = Promise.withResolvers<{ origin: string }>();
  a.projects.get.mockReturnValueOnce(lookup.promise);
  const request = postProjectCutExport({ projectId, isDryRun: false });
  const stopped = expect(request).rejects.toMatchObject({ name: "AbortError" });
  await waitFor(() => expect(a.projects.get).toHaveBeenCalledOnce());
  const drained = vi.fn();
  const suspend = rendererLibrary.suspend().then(drained);
  await Promise.resolve();
  expect(drained).not.toHaveBeenCalled();
  lookup.resolve({ origin: "local" });
  await suspend;
  const b = bridge("local");
  rendererLibrary.reset();
  await stopped;
  expect(a.scriptProjects.exportCut).not.toHaveBeenCalled();
  expect(b.scriptProjects.exportCut).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it("drains an issued local export submission without waiting for the accepted export", async () => {
  const { scriptProjects } = bridge("local");
  const submission = Promise.withResolvers<{ plan_id: string }>();
  scriptProjects.exportCut.mockReturnValueOnce(submission.promise);
  const request = postProjectCutExport({ projectId, isDryRun: false });
  const stopped = expect(request).rejects.toMatchObject({ name: "AbortError" });
  await waitFor(() => expect(scriptProjects.exportCut).toHaveBeenCalledOnce());
  const drained = vi.fn();
  const suspend = rendererLibrary.suspend().then(drained);
  await Promise.resolve();
  expect(drained).not.toHaveBeenCalled();
  submission.resolve({ plan_id: planId });
  await suspend;
  await stopped;
  expect(mocks.get).not.toHaveBeenCalled();
});

it("retires a pending export submission without invalidating or publishing into the replacement hook", async () => {
  bridge("cloud");
  const old = Promise.withResolvers<{ data: unknown }>();
  mocks.post
    .mockResolvedValueOnce({ data: {} })
    .mockReturnValueOnce(old.promise);
  const { client, wrapper } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(() => useExportCut(projectId, [], url), {
    wrapper
  });
  await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
  const oldAction = result.current.downloadCut;
  let pending!: Promise<void>;
  act(() => {
    pending = oldAction();
  });
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(result.current.isExportingCut).toBe(true);
  await act(async () => {
    await rendererLibrary.suspend();
    bridge("local", 2);
    rendererLibrary.reset();
  });
  expect(result.current.isExportingCut).toBe(false);
  await act(async () => {
    old.resolve({ data: { reused: true } });
    await pending;
    await oldAction();
  });
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(mocks.fetchMedia).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(result.current.failedExport).toBeNull();
});

it("drops a late export poll without invalidating or downloading for a reused plan ID", async () => {
  vi.useFakeTimers();
  try {
    const a = bridge("cloud", 1);
    mocks.post
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { plan_id: planId } });
    const poll = Promise.withResolvers<{ data: unknown }>();
    mocks.get.mockReturnValueOnce(poll.promise);
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useExportCut(projectId, [], url), {
      wrapper
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.downloadCut();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
      `/projects/${projectId}/cut`,
      { signal: expect.any(AbortSignal) }
    );
    let b!: ReturnType<typeof bridge>;
    await act(async () => {
      await rendererLibrary.suspend();
      b = bridge("local", 2);
      rendererLibrary.reset();
    });
    await act(async () => {
      poll.resolve({ data: { ...cut(3), export: { plan_id: planId, url } } });
      await pending;
    });
    expect(a.scriptProjects.put).not.toHaveBeenCalled();
    expect(b.scriptProjects.put).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(mocks.fetchMedia).not.toHaveBeenCalled();
    expect(result.current.failedExport).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("does not save an old stitched blob that settles after a switch", async () => {
  const a = bridge("local", 1);
  a.scriptProjects.exportCut.mockImplementation(async ({ isDryRun }) =>
    isDryRun ? { would_export: [1] } : { reused: true }
  );
  const body = Promise.withResolvers<Blob>();
  const blob = vi.fn(() => body.promise);
  mocks.fetchMedia.mockResolvedValueOnce({ ok: true, blob });
  const { wrapper } = setup();
  const { result } = renderHook(() => useExportCut(projectId, [], url), {
    wrapper
  });
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.downloadCut();
  });
  await waitFor(() => expect(blob).toHaveBeenCalledOnce());
  const signal = mocks.fetchMedia.mock.calls[0]?.[1].signal;
  await act(async () => {
    await rendererLibrary.suspend();
    bridge("local", 2);
    rendererLibrary.reset();
  });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    body.resolve(new Blob(["old"]));
    await pending;
  });
  expect(mocks.download).not.toHaveBeenCalled();
  expect(result.current.failedExport).toBeNull();
});
