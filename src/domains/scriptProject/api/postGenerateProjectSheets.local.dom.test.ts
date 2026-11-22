import { afterEach, describe, expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

import { executeCloudSheetPlan } from "../cloudSheetRender.local";
import { FAL_SHEET_MODEL, LOCAL_SHEET_RENDER_MODEL } from "../constants";

import { postGenerateProjectSheets } from "./postGenerateProjectSheets";

vi.mock("../cloudSheetRender.local", () => ({
  canUseCloudSheetModels: () => window.mago.account.mode === "cloud",
  executeCloudSheetPlan: vi.fn()
}));

describe("postGenerateProjectSheets (local project)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    Reflect.deleteProperty(window, "mago");
  });

  it("rejects cloud image models and strips the cloud metrics option", async () => {
    const generateSheets = vi.fn().mockResolvedValue({
      would_run: ["hero"],
      skipped: [],
      changed: {},
      plan_id: "plan-1"
    });
    Object.defineProperty(window, "mago", {
      configurable: true,
      value: {
        account: { mode: "local" },
        projects: {
          get: vi.fn().mockResolvedValue({
            id: "project-1",
            origin: "local",
            type: "script_to_shots"
          })
        },
        scriptProjects: { generateSheets }
      }
    });

    await postGenerateProjectSheets({
      projectId: "project-1",
      isDryRun: false,
      outputSize: [720, 1280],
      tokens: ["hero"],
      settings: { render_model: "seedream_5_pro_t2i" },
      shouldScoreImages: true
    });

    expect(generateSheets).toHaveBeenCalledWith({
      projectId: "project-1",
      isDryRun: false,
      outputSize: [720, 1280],
      tokens: ["hero"],
      settings: { render_model: LOCAL_SHEET_RENDER_MODEL }
    });
    expect(generateSheets.mock.calls[0]?.[0]).not.toHaveProperty(
      "shouldScoreImages"
    );
  });

  it.each(["flux2_klein_4b_q8_local", FAL_SHEET_MODEL])(
    "preserves %s on desktop dry runs",
    async (renderModel) => {
      const generateSheets = vi.fn().mockResolvedValue({
        would_run: [],
        skipped: [],
        changed: {}
      });
      Object.defineProperty(window, "mago", {
        configurable: true,
        value: {
          account: { mode: "local" },
          projects: {
            get: vi.fn().mockResolvedValue({
              id: "project-1",
              origin: "local",
              type: "script_to_shots"
            })
          },
          scriptProjects: { generateSheets }
        }
      });

      await postGenerateProjectSheets({
        projectId: "project-1",
        isDryRun: true,
        settings: { render_model: renderModel }
      });

      expect(generateSheets).toHaveBeenCalledWith({
        projectId: "project-1",
        isDryRun: true,
        settings: { render_model: renderModel }
      });
    }
  );
  it("uses the original work for the accepted plan, but never launches a dry run", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const generateSheets = vi.fn().mockResolvedValue({ plan_id: "same-plan" });
    Object.defineProperty(window, "mago", {
      configurable: true,
      value: {
        account: { mode: "cloud" },
        projects: { get: vi.fn().mockResolvedValue({ origin: "local" }) },
        scriptProjects: { generateSheets }
      }
    });
    const request = {
      projectId: "same-project",
      settings: { render_model: "gpt_image_2_t2i" }
    };
    await postGenerateProjectSheets({ ...request, isDryRun: true }, work);
    expect(executeCloudSheetPlan).not.toHaveBeenCalled();
    await postGenerateProjectSheets({ ...request, isDryRun: false }, work);
    expect(executeCloudSheetPlan).toHaveBeenCalledExactlyOnceWith(
      "same-plan",
      work
    );
  });

  it("drains an issued local plan write but never launches the old plan", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const issued = Promise.withResolvers<void>();
    const write = Promise.withResolvers<object>();
    const generateSheets = vi.fn(() => {
      issued.resolve();
      return write.promise;
    });
    Object.defineProperty(window, "mago", {
      configurable: true,
      value: {
        account: { mode: "cloud" },
        projects: { get: vi.fn().mockResolvedValue({ origin: "local" }) },
        scriptProjects: { generateSheets }
      }
    });
    const submitted = postGenerateProjectSheets(
      {
        projectId: "same-project",
        isDryRun: false,
        settings: { render_model: "gpt_image_2_t2i" }
      },
      work
    );
    const stale = expect(submitted).rejects.toMatchObject({
      name: "AbortError"
    });
    await issued.promise;
    const acknowledged = vi.fn();
    const suspension = library.suspend().then(acknowledged);
    await Promise.resolve();
    expect(acknowledged).not.toHaveBeenCalled();
    write.resolve({ plan_id: "same-plan" });
    await suspension;
    library.reset();
    await stale;
    expect(executeCloudSheetPlan).not.toHaveBeenCalled();
  });

  it("does not wait for a main-owned Flux readiness probe before acknowledging", async () => {
    const library = new RendererLibrarySession();
    const issued = Promise.withResolvers<void>();
    const probe = Promise.withResolvers<object>();
    const generateSheets = vi.fn(() => {
      issued.resolve();
      return probe.promise;
    });
    Object.defineProperty(window, "mago", {
      configurable: true,
      value: {
        account: { mode: "local" },
        projects: { get: vi.fn().mockResolvedValue({ origin: "local" }) },
        scriptProjects: { generateSheets }
      }
    });
    const pending = postGenerateProjectSheets(
      {
        projectId: "same-project",
        isDryRun: false,
        settings: { render_model: "flux2_klein_4b_q8_local" }
      },
      library.capture()
    );
    const settled = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    await issued.promise;
    await library.suspend();
    library.reset();
    probe.resolve({ plan_id: "same-plan" });
    await settled;
    expect(executeCloudSheetPlan).not.toHaveBeenCalled();
  });
});
