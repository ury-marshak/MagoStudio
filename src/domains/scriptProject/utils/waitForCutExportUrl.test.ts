import { beforeEach, describe, expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

vi.mock("../api/getProjectCut", () => ({ getProjectCut: vi.fn() }));

import { getProjectCut } from "../api/getProjectCut";

import { waitForCutExportUrl } from "./waitForCutExportUrl";

const getProjectCutMock = getProjectCut as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ID = "project-1";
const PLAN_ID = "plan-1";
const EXPORT_URL = "https://cdn.example.com/cut.mp4";

const cutWithExport = (
  exportFields: Record<string, unknown> | null
): unknown => ({
  project_id: PROJECT_ID,
  shots: [],
  missing: [],
  export: exportFields
});

const noSleep = () => Promise.resolve();

describe("waitForCutExportUrl", () => {
  beforeEach(() => {
    getProjectCutMock.mockReset();
  });

  it("returns the URL once the upload has landed", async () => {
    getProjectCutMock.mockResolvedValueOnce(
      cutWithExport({ plan_id: PLAN_ID, url: EXPORT_URL, stale: false })
    );

    await expect(
      waitForCutExportUrl({
        projectId: PROJECT_ID,
        planId: PLAN_ID,
        sleep: noSleep
      })
    ).resolves.toBe(EXPORT_URL);
  });

  it("keeps polling while the file has no URL yet", async () => {
    getProjectCutMock
      .mockResolvedValueOnce(
        cutWithExport({ plan_id: PLAN_ID, url: null, stale: false })
      )
      .mockResolvedValueOnce(
        cutWithExport({ plan_id: PLAN_ID, url: EXPORT_URL, stale: false })
      );

    await expect(
      waitForCutExportUrl({
        projectId: PROJECT_ID,
        planId: PLAN_ID,
        sleep: noSleep
      })
    ).resolves.toBe(EXPORT_URL);
    expect(getProjectCutMock).toHaveBeenCalledTimes(2);
  });

  it("ignores an older export still recorded on the cut", async () => {
    getProjectCutMock
      .mockResolvedValueOnce(
        cutWithExport({
          plan_id: "an-earlier-plan",
          url: "https://cdn.example.com/yesterday.mp4",
          stale: true
        })
      )
      .mockResolvedValueOnce(
        cutWithExport({ plan_id: PLAN_ID, url: EXPORT_URL, stale: false })
      );

    await expect(
      waitForCutExportUrl({
        projectId: PROJECT_ID,
        planId: PLAN_ID,
        sleep: noSleep
      })
    ).resolves.toBe(EXPORT_URL);
  });

  it("gives up rather than polling forever, so the caller can fall back", async () => {
    getProjectCutMock.mockResolvedValue(cutWithExport(null));

    await expect(
      waitForCutExportUrl({
        projectId: PROJECT_ID,
        planId: PLAN_ID,
        sleep: noSleep
      })
    ).resolves.toBeNull();
  });

  it("does not read the replacement cut when a poll sleep ignores abort", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const sleep = Promise.withResolvers<void>();
    const poll = waitForCutExportUrl({
      projectId: PROJECT_ID,
      planId: PLAN_ID,
      work,
      sleep: () => sleep.promise
    });
    const stopped = expect(poll).rejects.toMatchObject({ name: "AbortError" });
    await library.suspend();
    library.reset();
    sleep.resolve();
    await stopped;
    expect(getProjectCutMock).not.toHaveBeenCalled();
  });

  it("clears the default poll timer on retirement", async () => {
    vi.useFakeTimers();
    try {
      const library = new RendererLibrarySession();
      const poll = waitForCutExportUrl({
        projectId: PROJECT_ID,
        planId: PLAN_ID,
        work: library.capture()
      });
      const stopped = expect(poll).rejects.toMatchObject({
        name: "AbortError"
      });
      expect(vi.getTimerCount()).toBe(1);
      await library.suspend();
      await stopped;
      expect(vi.getTimerCount()).toBe(0);
      expect(getProjectCutMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
