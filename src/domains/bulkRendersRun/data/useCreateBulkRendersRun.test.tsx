import {
  MutationCache,
  QueryClient,
  QueryClientProvider
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { postBulkRendersRun } from "../api/postBulkRendersRun";

import { useCreateBulkRendersRun } from "./useCreateBulkRendersRun";

vi.mock("../api/postBulkRendersRun", () => ({
  postBulkRendersRun: vi.fn(async () => ({
    id: "run-1",
    status: "PENDING"
  }))
}));

const PROJECT_ID = "project-1";

const renderWithClient = (mutationCache = new MutationCache()) => {
  const queryClient = new QueryClient({ mutationCache });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCreateBulkRendersRun(), { wrapper });
  return { result, invalidateSpy };
};

describe("useCreateBulkRendersRun", () => {
  it("refreshes the Project's run list from the request's Project id, so a response omitting the field still refreshes", async () => {
    const { result, invalidateSpy } = renderWithClient();

    await act(() =>
      result.current.mutateAsync({
        project_id: PROJECT_ID,
        timeline_ids: ["shot-1"]
      })
    );

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.bulkRendersRuns.byProjectId(PROJECT_ID)
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.bulkRendersRuns.everyProject()
    });
  });

  it("never keys the invalidation off the response, which carries no Project id at all", async () => {
    const { result, invalidateSpy } = renderWithClient();

    await act(() =>
      result.current.mutateAsync({
        project_id: PROJECT_ID,
        timeline_ids: ["shot-1"]
      })
    );

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      ([options]) => options?.queryKey
    );

    for (const invalidatedKey of invalidatedKeys) {
      expect(invalidatedKey).not.toContain(undefined);
    }
  });

  it("does not dispatch an old run queued before a library switch", async () => {
    const held = Promise.withResolvers<void>();
    const onMutate = vi.fn(() => held.promise);
    const { result, invalidateSpy } = renderWithClient(
      new MutationCache({ onMutate })
    );
    vi.mocked(postBulkRendersRun).mockClear();
    const input = { project_id: PROJECT_ID, timeline_ids: ["shot-1"] };
    let oldRun!: Promise<unknown>;
    await act(async () => {
      oldRun = result.current
        .mutateAsync(input)
        .catch((error: unknown) => error);
    });
    await waitFor(() => expect(onMutate).toHaveBeenCalledOnce());
    expect(result.current.isPending).toBe(true);
    await act(async () => {
      await rendererLibrary.suspend();
      rendererLibrary.reset();
    });
    expect(result.current.isPending).toBe(false);
    await act(async () => {
      held.resolve();
      expect(await oldRun).toMatchObject({ name: "AbortError" });
    });
    expect(postBulkRendersRun).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();

    await act(() => result.current.mutateAsync(input));
    expect(postBulkRendersRun).toHaveBeenCalledOnce();
  });
});
