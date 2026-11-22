import { useBulkRendersRunsAcrossProjects } from "@domains/bulkRendersRun/useBulkRendersRuns";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { usePlanProgress } from "./usePlanProgress";

const { fetchProgress, fetchRuns } = vi.hoisted(() => ({
  fetchProgress: vi.fn(),
  fetchRuns: vi.fn()
}));

vi.mock("@/platform/localDesktop", async (original) => ({
  ...(await original<typeof import("@/platform/localDesktop")>()),
  isLocalApp: true,
  getLocalDesktopApi: () => ({
    library: { onWillChange: async () => {}, onDidChange: () => {} }
  })
}));
vi.mock("../api/fetchPlanProgress", () => ({
  fetchPlanProgress: fetchProgress
}));
vi.mock("@domains/bulkRendersRun/api/fetchBulkRendersRuns", () => ({
  fetchBulkRendersRuns: fetchRuns
}));

it("does not authorize a resume from old progress or rows with a reused plan ID", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const Wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const oldPlan = { id: "same-plan", name: "original", status: "PAUSED" };
  const newPlan = { id: "same-plan", name: "replacement", status: "PAUSED" };
  let allowReplacement!: () => void;
  const replacementReady = new Promise<void>((resolve) => {
    allowReplacement = resolve;
  });
  fetchProgress.mockResolvedValueOnce(oldPlan).mockImplementation(async () => {
    await replacementReady;
    return newPlan;
  });
  fetchRuns.mockResolvedValueOnce([oldPlan]).mockImplementation(async () => {
    await replacementReady;
    return [newPlan];
  });
  const { result, unmount } = renderHook(
    () => ({
      progress: usePlanProgress(oldPlan.id),
      bulk: useBulkRendersRunsAcrossProjects()
    }),
    { wrapper: Wrapper }
  );
  await waitFor(() => {
    expect(result.current.progress.data).toEqual(oldPlan);
    expect(result.current.bulk.data).toEqual([oldPlan]);
  });
  const old = result.current;
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
  expect(old.progress.work.signal.aborted).toBe(true);
  expect(old.bulk.work.signal.aborted).toBe(true);
  expect(result.current.progress.data).toBeUndefined();
  expect(result.current.bulk.data).toBeUndefined();
  allowReplacement();
  await waitFor(() => {
    expect(result.current.progress.data).toEqual(newPlan);
    expect(result.current.bulk.data).toEqual([newPlan]);
  });
  expect(result.current.bulk.work.signal.aborted).toBe(false);
  expect(result.current.progress.work.signal.aborted).toBe(false);
  unmount();
  queryClient.clear();
});
