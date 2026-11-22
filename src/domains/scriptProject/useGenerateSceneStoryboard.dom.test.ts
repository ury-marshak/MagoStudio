import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { useGenerateSceneStoryboard } from "./useGenerateSceneStoryboard";
import { Beat } from "./utils/shotCutListTypes";

const uploadReferenceImage = vi.hoisted(() => vi.fn());
vi.mock("@domains/asset/useUploadReferenceImage", () => ({
  useUploadReferenceImage: () => ({ mutateAsync: uploadReferenceImage })
}));

const renderShotStoryboard = vi.hoisted(() => vi.fn());
vi.mock("./data/useRenderShotStoryboard", () => ({
  useRenderShotStoryboard: () => ({ mutateAsync: renderShotStoryboard })
}));

const editSheetGroup = vi.hoisted(() => vi.fn());
vi.mock("./data/useEditSheetGroup", () => ({
  useEditSheetGroup: () => ({ mutateAsync: editSheetGroup })
}));

const pinSheetGroupImage = vi.hoisted(() => vi.fn());
vi.mock("./data/usePinSheetGroupImage", () => ({
  usePinSheetGroupImage: () => ({ mutateAsync: pinSheetGroupImage })
}));

const renderStoryboardInputImage = vi.hoisted(() => vi.fn());
vi.mock("./renderStoryboardInputImage", () => ({ renderStoryboardInputImage }));

const reportScriptProjectFailure = vi.hoisted(() => vi.fn());
vi.mock("./useReportScriptProjectFailure", () => ({
  useReportScriptProjectFailure: () => reportScriptProjectFailure
}));

const storyboardBeats: Beat[] = [
  {
    framing: "",
    action: "The hero walks in",
    cameraMovement: "",
    cameraSentenceKind: "none",
    spokenLines: "",
    durationSeconds: 3
  }
];

const sceneWithTimelineId = (timelineId: string) => ({
  timeline_id: timelineId,
  tags: { characters: [], environments: [], props: [] }
});

const renderStoryboardHook = () => {
  const onStoryboardRenderAccepted = vi.fn();
  const hook = renderHook(
    ({ projectId, sheetsTimelineId }) =>
      useGenerateSceneStoryboard({
        projectId,
        sheetsTimelineId,
        projectOutputSize: [1920, 1080],
        sheetGroups: [],
        storyboardSheetGroups: [],
        onStoryboardRenderAccepted
      }),
    {
      initialProps: {
        projectId: "project",
        sheetsTimelineId: "sheets-timeline"
      }
    }
  );
  return { ...hook, onStoryboardRenderAccepted };
};

const switchLibrary = async () => {
  await rendererLibrary.suspend();
  rendererLibrary.reset();
};

afterEach(switchLibrary);

describe("useGenerateSceneStoryboard", () => {
  beforeEach(() => {
    renderStoryboardInputImage
      .mockReset()
      .mockResolvedValue(new File(["grid"], "grid.png", { type: "image/png" }));
    uploadReferenceImage.mockReset().mockResolvedValue("grid-asset");
    renderShotStoryboard.mockReset();
    editSheetGroup.mockReset().mockResolvedValue(undefined);
    pinSheetGroupImage.mockReset().mockResolvedValue(undefined);
    reportScriptProjectFailure.mockReset();
  });

  it("reports a scene's render as accepted only once the render request succeeds", async () => {
    let acceptRender: () => void = () => {};
    renderShotStoryboard.mockReturnValue(
      new Promise<void>((resolve) => {
        acceptRender = resolve;
      })
    );
    const { result, onStoryboardRenderAccepted } = renderStoryboardHook();

    act(() =>
      result.current.generateSceneStoryboard({
        shot: sceneWithTimelineId("scene-a"),
        storyboardBeats
      })
    );
    await waitFor(() => expect(renderShotStoryboard).toHaveBeenCalled());
    expect(onStoryboardRenderAccepted).not.toHaveBeenCalled();

    await act(async () => acceptRender());

    expect(onStoryboardRenderAccepted).toHaveBeenCalledWith("scene-a");
    expect(result.current.isSubmittingSceneStoryboard("scene-a")).toBe(false);
  });

  it("reports every scene sent at once, not only the last one", async () => {
    renderShotStoryboard.mockResolvedValue(undefined);
    const { result, onStoryboardRenderAccepted } = renderStoryboardHook();

    act(() => {
      result.current.generateSceneStoryboard({
        shot: sceneWithTimelineId("scene-a"),
        storyboardBeats
      });
      result.current.generateSceneStoryboard({
        shot: sceneWithTimelineId("scene-b"),
        storyboardBeats
      });
    });

    await waitFor(() =>
      expect(onStoryboardRenderAccepted).toHaveBeenCalledTimes(2)
    );
    expect(onStoryboardRenderAccepted).toHaveBeenCalledWith("scene-a");
    expect(onStoryboardRenderAccepted).toHaveBeenCalledWith("scene-b");
    expect(result.current.isSubmittingSceneStoryboard("scene-a")).toBe(false);
    expect(result.current.isSubmittingSceneStoryboard("scene-b")).toBe(false);
  });

  it("reports a refused render as a failure and never as accepted", async () => {
    renderShotStoryboard.mockRejectedValue(new Error("refused"));
    const { result, onStoryboardRenderAccepted } = renderStoryboardHook();

    act(() =>
      result.current.generateSceneStoryboard({
        shot: sceneWithTimelineId("scene-a"),
        storyboardBeats
      })
    );

    await waitFor(() => expect(reportScriptProjectFailure).toHaveBeenCalled());
    expect(onStoryboardRenderAccepted).not.toHaveBeenCalled();
    expect(result.current.isSubmittingSceneStoryboard("scene-a")).toBe(false);
  });

  it("retries only the sheet setup, never the paid render, when setup fails after the render was accepted", async () => {
    renderShotStoryboard.mockResolvedValue(undefined);
    editSheetGroup.mockRejectedValueOnce(new Error("sheet edit failed"));
    const { result, onStoryboardRenderAccepted } = renderStoryboardHook();

    act(() =>
      result.current.generateSceneStoryboard({
        shot: sceneWithTimelineId("scene-a"),
        storyboardBeats
      })
    );
    await waitFor(() => expect(reportScriptProjectFailure).toHaveBeenCalled());
    expect(onStoryboardRenderAccepted).toHaveBeenCalledWith("scene-a");

    const retry = reportScriptProjectFailure.mock.calls[0][2] as () => void;
    await act(async () => retry());

    await waitFor(() => expect(editSheetGroup).toHaveBeenCalledTimes(2));
    expect(renderShotStoryboard).toHaveBeenCalledTimes(1);
    expect(uploadReferenceImage).toHaveBeenCalledTimes(1);

    await act(switchLibrary);
    await act(async () => retry());
    expect(pinSheetGroupImage).toHaveBeenCalledTimes(2);
    expect(editSheetGroup).toHaveBeenCalledTimes(2);
    expect(renderShotStoryboard).toHaveBeenCalledOnce();
  });

  it("does not upload a grid prepared for an old library", async () => {
    const grid = Promise.withResolvers<File>();
    renderStoryboardInputImage.mockReturnValueOnce(grid.promise);
    const { result } = renderStoryboardHook();
    act(() =>
      result.current.generateSceneStoryboard({
        shot: sceneWithTimelineId("reused"),
        storyboardBeats
      })
    );
    expect(renderStoryboardInputImage).toHaveBeenCalledOnce();

    await act(switchLibrary);
    await act(async () => grid.resolve(new File(["old"], "old.png")));
    expect(uploadReferenceImage).not.toHaveBeenCalled();
    expect(renderShotStoryboard).not.toHaveBeenCalled();
    expect(reportScriptProjectFailure).not.toHaveBeenCalled();
    expect(result.current.isSubmittingSceneStoryboard("reused")).toBe(false);
  });

  it("ignores late acceptance without clearing a replacement submission for the same scene", async () => {
    const old = Promise.withResolvers<void>();
    const replacement = Promise.withResolvers<void>();
    renderShotStoryboard
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(replacement.promise);
    const { result, onStoryboardRenderAccepted } = renderStoryboardHook();
    const request = { shot: sceneWithTimelineId("reused"), storyboardBeats };
    await act(async () => result.current.generateSceneStoryboard(request));
    expect(renderShotStoryboard).toHaveBeenCalledOnce();

    await act(switchLibrary);
    expect(result.current.isSubmittingSceneStoryboard("reused")).toBe(false);
    await act(async () => result.current.generateSceneStoryboard(request));
    expect(renderShotStoryboard).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve());

    expect(onStoryboardRenderAccepted).not.toHaveBeenCalled();
    expect(pinSheetGroupImage).not.toHaveBeenCalled();
    expect(editSheetGroup).not.toHaveBeenCalled();
    expect(reportScriptProjectFailure).not.toHaveBeenCalled();
    expect(result.current.isSubmittingSceneStoryboard("reused")).toBe(true);

    await act(async () => replacement.resolve());
    expect(onStoryboardRenderAccepted).toHaveBeenCalledExactlyOnceWith(
      "reused"
    );
    expect(result.current.isSubmittingSceneStoryboard("reused")).toBe(false);
  });

  it("keeps the original project, sheet and work after navigation in the same library", async () => {
    const grid = Promise.withResolvers<File>();
    renderStoryboardInputImage.mockReturnValueOnce(grid.promise);
    const { result, rerender } = renderStoryboardHook();
    const work = rendererLibrary.capture();
    act(() =>
      result.current.generateSceneStoryboard(
        { shot: sceneWithTimelineId("scene-a"), storyboardBeats },
        work
      )
    );
    rerender({ projectId: "navigated", sheetsTimelineId: "other-sheets" });
    expect(result.current.isSubmittingSceneStoryboard("scene-a")).toBe(false);
    await act(async () => grid.resolve(new File(["grid"], "grid.png")));

    expect(uploadReferenceImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ projectId: "project", work })
    );
    expect(renderShotStoryboard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sheetsTimelineId: "sheets-timeline",
        shotTimelineId: "scene-a"
      }),
      work
    );
    expect(pinSheetGroupImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timelineId: "sheets-timeline" }),
      work
    );
    expect(editSheetGroup).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timelineId: "sheets-timeline" }),
      work
    );
  });
});
