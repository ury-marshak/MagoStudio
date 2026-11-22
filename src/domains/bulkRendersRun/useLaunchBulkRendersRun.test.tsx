import { Img2ImgSchema } from "@home/components/Navbar/Img2ImgModalV2/schemas";
import { seedance2Model } from "@models/video/seedance2Model";
import { bulkRenderingFlowAtom } from "@store/atoms";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { PropsWithChildren } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { useLaunchBulkRendersRun } from "./useLaunchBulkRendersRun";

const { postBulkRendersRun, showToast } = vi.hoisted(() => ({
  postBulkRendersRun: vi.fn(),
  showToast: vi.fn()
}));

vi.mock("./api/postBulkRendersRun", () => ({ postBulkRendersRun }));
vi.mock("@domains/project/useSelectedProjectId", () => ({
  useSelectedProjectId: () => "project-1"
}));
vi.mock("@domains/renders/useBlockRenderWhileLocalSetupRuns", () => ({
  useBlockRenderWhileLocalSetupRuns: () => () => false
}));
vi.mock("@store/useToast", () => ({ useToast: () => ({ showToast }) }));

beforeEach(() => vi.clearAllMocks());

const setup = () => {
  const store = createStore();
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useLaunchBulkRendersRun({
        selectedShotIds: ["shot-1"],
        masterSettings: {
          imageSettings: Img2ImgSchema.parse({
            model: "gpt_image_2",
            frameType: "video"
          }),
          videoSettings: {
            mago_engine: seedance2Model.name,
            prompt: "a valid master prompt"
          },
          videoModel: seedance2Model,
          frameRange: [0, 48],
          isFullFrameRangePresetSelected: false
        },
        isTeamMember: false,
        firstFrameSource: "generated",
        shotMaxFramesById: new Map()
      }),
    { wrapper }
  );
  return { result, store, invalidate };
};

it.each(["accepts", "rejects"])(
  "preserves the replacement view after an old run %s late",
  async (outcome) => {
    const response = Promise.withResolvers<{ id: string }>();
    postBulkRendersRun.mockReturnValueOnce(response.promise);
    const { result, store, invalidate } = setup();
    const launching = result.current.launchBulkRendersRun("run");
    await waitFor(() => expect(result.current.isLaunching).toBe(true));
    await waitFor(() => expect(postBulkRendersRun).toHaveBeenCalledOnce());
    const replacementView = {
      view: "shotSelection",
      selectedShotIds: new Set(["shot-1"])
    } as const;
    await act(async () => {
      await rendererLibrary.suspend();
      rendererLibrary.reset();
      store.set(bulkRenderingFlowAtom, replacementView);
    });
    expect(result.current.isLaunching).toBe(false);
    await act(async () => {
      if (outcome === "accepts") response.resolve({ id: "old-run" });
      else response.reject(new Error("old failure"));
      await launching;
    });
    expect(store.get(bulkRenderingFlowAtom)).toBe(replacementView);
    expect(showToast).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(postBulkRendersRun).toHaveBeenCalledOnce();
  }
);

it("opens an accepted run while its library is active", async () => {
  postBulkRendersRun.mockResolvedValueOnce({ id: "new-run" });
  const { result, store } = setup();
  await act(() => result.current.launchBulkRendersRun("run"));
  expect(store.get(bulkRenderingFlowAtom)).toEqual({
    view: "run",
    bulkRunId: "new-run"
  });
});
