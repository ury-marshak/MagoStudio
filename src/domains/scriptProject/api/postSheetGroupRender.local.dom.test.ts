import { RenderMode } from "@hooks/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { backendApiClient } from "@/lib/backend-api-client";
import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

import { executeCloudSheetPlan } from "../cloudSheetRender.local";
import { FAL_SHEET_MODEL, FAL_SHEET_MODEL_H3 } from "../constants";

import { postSheetGroupRender } from "./postSheetGroupRender";

vi.mock("@domains/cloud/mirrorService", () => ({
  ensureCloudImageAsset: vi.fn().mockResolvedValue("cloud-reference-1")
}));

vi.mock("../cloudSheetRender.local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudSheetRender.local")>()),
  canUseCloudSheetModels: () => true,
  executeCloudSheetPlan: vi.fn()
}));

describe("postSheetGroupRender (local project)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    Reflect.deleteProperty(window, "mago");
  });

  it.each([
    "flux2_klein_4b_q8_local",
    FAL_SHEET_MODEL,
    FAL_SHEET_MODEL_H3
  ] as const)(
    "returns the local plan for %s so the UI can track the image",
    async (renderModel) => {
      const result = {
        would_run: ["baker"],
        skipped: [],
        changed: {},
        plan_id: "plan-1"
      };
      const generateSheets = vi.fn().mockResolvedValue(result);
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

      await expect(
        postSheetGroupRender({
          projectId: "project-1",
          timelineId: "sheets-1",
          token: "baker",
          prompt: "A baker in a hand-painted animation style",
          renderModel,
          renderMode: RenderMode.CREDITS,
          outputSize: [720, 1280],
          referenceAssetIds: ["reference-1"],
          referenceInstruction: "Use the coat and hairstyle"
        })
      ).resolves.toEqual(result);

      expect(generateSheets).toHaveBeenCalledWith({
        projectId: "project-1",
        isDryRun: false,
        outputSize: [720, 1280],
        settings: {
          prompt: "A baker in a hand-painted animation style",
          render_model: renderModel
        },
        tokens: ["baker"],
        referenceAssetIds: ["reference-1"],
        referenceInstruction: "Use the coat and hairstyle"
      });
    }
  );

  it("asks the desktop to create the entity it renders, as the cloud does with sheet_name and sheet_kind", async () => {
    const generateSheets = vi.fn().mockResolvedValue({
      would_run: ["baker"],
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

    await postSheetGroupRender({
      projectId: "project-1",
      timelineId: "sheets-1",
      token: "baker",
      name: "The Baker",
      kind: "character",
      prompt: "A baker in flour-dusted overalls",
      renderModel: "flux2_klein_4b_q8_local",
      renderMode: RenderMode.CREDITS,
      outputSize: [720, 1280]
    });

    expect(generateSheets).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ["baker"],
        sheetGroupToCreate: { name: "The Baker", kind: "character" }
      })
    );
  });

  it("mirrors and sends reference inputs for a cloud project", async () => {
    Object.defineProperty(window, "mago", {
      configurable: true,
      value: {
        account: { mode: "cloud" },
        projects: {
          get: vi.fn().mockResolvedValue({
            id: "project-1",
            origin: "cloud",
            type: "script_to_shots"
          })
        }
      }
    });
    const patch = vi.spyOn(backendApiClient, "patch").mockResolvedValue({
      data: { token: "baker", name: "Baker", layer_id: "layer" }
    });
    const post = vi.spyOn(backendApiClient, "post").mockResolvedValue({
      data: { would_run: ["baker"], skipped: [], changed: {} }
    });

    await postSheetGroupRender({
      projectId: "project-1",
      timelineId: "sheets-1",
      token: "baker",
      prompt: "A baker",
      renderModel: "nanobanana_2_t2i",
      renderMode: RenderMode.CREDITS,
      outputSize: [1280, 720],
      referenceAssetIds: ["local-reference-1"],
      referenceInstruction: "Use the coat and hairstyle"
    });

    expect(patch).toHaveBeenCalledWith(
      "/timelines/sheets-1/sheets/baker/edit",
      {
        reference_asset_ids: ["cloud-reference-1"],
        reference_instruction: "Use the coat and hairstyle"
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(post).toHaveBeenCalledWith(
      "/assets/img2img/render",
      {
        timeline_id: "sheets-1",
        sheet_token: "baker",
        img_file_type: "png",
        render_model: "nanobanana_2",
        render_mode: RenderMode.CREDITS,
        source_asset: "cloud-reference-1",
        frame: 0,
        settings: {
          prompt:
            "A baker\n\nUse the supplied reference images as follows: Use the coat and hairstyle",
          width: 1280,
          height: 720,
          input_image_id: "cloud-reference-1",
          reference_images: []
        }
      },
      { signal: expect.any(AbortSignal) }
    );
  });
  it("hands single-sheet Cloud plans the same work that created them", async () => {
    const work = new RendererLibrarySession().capture();
    Object.defineProperty(window, "mago", {
      configurable: true,
      value: {
        projects: { get: vi.fn().mockResolvedValue({ origin: "local" }) },
        scriptProjects: {
          generateSheets: vi.fn().mockResolvedValue({ plan_id: "same-plan" })
        }
      }
    });
    await postSheetGroupRender(
      {
        projectId: "same-project",
        timelineId: "same-sheets",
        token: "baker",
        prompt: "Baker",
        renderModel: "nanobanana_2_t2i",
        renderMode: RenderMode.CREDITS,
        outputSize: [1280, 720]
      },
      work
    );
    expect(executeCloudSheetPlan).toHaveBeenCalledExactlyOnceWith(
      "same-plan",
      work
    );
  });

  it("never dispatches a render after an old reference edit comes back", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const edited = Promise.withResolvers<{ data: object }>();
    const dispatched = Promise.withResolvers<void>();
    const patch = vi
      .spyOn(backendApiClient, "patch")
      .mockImplementationOnce(() => {
        dispatched.resolve();
        return edited.promise;
      });
    const post = vi
      .spyOn(backendApiClient, "post")
      .mockResolvedValue({ data: {} });
    const rendering = postSheetGroupRender(
      {
        timelineId: "same-sheets",
        token: "baker",
        prompt: "Baker",
        renderModel: "nanobanana_2_t2i",
        renderMode: RenderMode.CREDITS,
        outputSize: [1280, 720],
        referenceAssetIds: []
      },
      work
    );
    const stale = expect(rendering).rejects.toMatchObject({
      name: "AbortError"
    });
    await dispatched.promise;
    await library.suspend();
    library.reset();
    expect(patch.mock.calls[0]?.[2]).toEqual({ signal: work.signal });
    edited.resolve({
      data: { token: "baker", name: "Baker", layer_id: "layer" }
    });
    await stale;
    expect(post).not.toHaveBeenCalled();
  });
});
