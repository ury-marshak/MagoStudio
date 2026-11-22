import { RenderMode } from "@hooks/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useRenderSheetGroup } from "./useRenderSheetGroup";

const { post, report } = vi.hoisted(() => ({ post: vi.fn(), report: vi.fn() }));
vi.mock("./api/postSheetGroupRender", () => ({ postSheetGroupRender: post }));
vi.mock("./useReportScriptProjectFailure", () => ({
  useReportScriptProjectFailure: () => report
}));

it.each([false, true])(
  "settles against the initiating project (library replaced: %s)",
  async (replaceLibrary) => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(useRenderSheetGroup, {
      wrapper,
      initialProps: "original"
    });
    const library = new RendererLibrarySession();
    const work = library.capture();
    const issued = Promise.withResolvers<void>();
    const acceptance = Promise.withResolvers<object>();
    post.mockImplementationOnce(() => {
      issued.resolve();
      return acceptance.promise;
    });
    const onSuccess = vi.fn();
    let submission!: Promise<unknown>;
    await act(async () => {
      submission = hook.result.current
        .mutateAsync(
          {
            token: "sheet",
            timelineId: "same-timeline",
            prompt: "Portrait",
            outputSize: [720, 1280],
            renderModel: "gpt_image_2_t2i",
            renderMode: RenderMode.CREDITS
          },
          work,
          onSuccess
        )
        .catch((error: unknown) => error);
      await issued.promise;
    });
    hook.rerender(replaceLibrary ? "original" : "next");
    if (replaceLibrary) {
      await library.suspend();
      library.reset();
    }
    const accepted = {
      plan_id: "same-plan",
      would_run: ["sheet"],
      skipped: [],
      changed: {}
    };
    let outcome: unknown;
    await act(async () => {
      acceptance.resolve(accepted);
      outcome = await submission;
    });
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "original" }),
      work
    );
    expect(report).not.toHaveBeenCalled();
    if (replaceLibrary) {
      expect(outcome).toMatchObject({ name: "AbortError" });
      expect(onSuccess).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    } else {
      expect(outcome).toBe(accepted);
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(accepted);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.projectState.byProjectId("original")
      });
      expect(invalidate).not.toHaveBeenCalledWith({
        queryKey: queryKeys.projectState.byProjectId("next")
      });
    }
  }
);
