import { afterEach, describe, expect, it, vi } from "vitest";

const {
  post,
  get,
  ensureCloudImageAsset,
  ensureCloudProject,
  ensureCloudTimeline,
  canRender
} = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  ensureCloudImageAsset: vi.fn(),
  ensureCloudProject: vi.fn(),
  ensureCloudTimeline: vi.fn(),
  canRender: { value: true }
}));

vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { post, get }
}));
vi.mock("@domains/cloud/mirrorService", async (original) => ({
  ...(await original<typeof import("@domains/cloud/mirrorService")>()),
  ensureCloudImageAsset,
  ensureCloudProject,
  ensureCloudTimeline
}));
vi.mock("@platform/renderTarget", () => ({
  isCloudRenderAvailable: () => canRender.value
}));
vi.mock("@/platform/providerPreferences", () => ({
  readProviderPreferences: () => ({ "mago-cloud": true })
}));

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

import { executeCloudSheetPlan } from "./cloudSheetRender.local";

const target = (overrides: Record<string, unknown> = {}) => ({
  token: "mara",
  name: "Mara",
  kind: "character",
  _local_render_prompt: "Mara, turnaround\n\nPainterly",
  _local_spec: { kind: "sheet", token: "mara", prompt: "Mara, turnaround" },
  _local_reference_asset_ids: [],
  ...overrides
});

const installBridge = (plan: Record<string, unknown>) => {
  const update = vi.fn().mockResolvedValue({});
  vi.stubGlobal("mago", {
    projects: {
      get: vi.fn().mockResolvedValue({ id: "local-1", name: "Drama" })
    },
    scriptProjects: {
      getPlan: vi.fn().mockResolvedValue(plan),
      get: vi.fn().mockResolvedValue({
        state: {
          sheets_timeline_id: "sheets-1",
          keys: [{ token: "mara", effective_asset_id: "master-1" }]
        }
      }),
      update
    }
  });
  return update;
};

const cloudPlan = (
  targets: Record<string, unknown>[],
  steps: Record<string, unknown>[] = []
) => ({
  id: "plan-1",
  project_id: "local-1",
  status: "RUNNING",
  local_executor: "mago-cloud-renderer",
  local_execution_session: "library-session",
  local_request: {
    outputSize: [1024, 1024],
    settings: { render_model: "seedream_5_pro_t2i" }
  },
  local_targets: targets,
  steps
});

describe("executeCloudSheetPlan", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    canRender.value = true;
  });

  const succeed = () => {
    ensureCloudProject.mockResolvedValue("cloud-project-1");
    ensureCloudTimeline.mockResolvedValue("cloud-sheets-1");
    post.mockResolvedValue({
      data: { clips: [{ id: "clip-1", asset: { id: "cloud-asset-1" } }] }
    });
    get.mockResolvedValue({
      data: {
        render_status: "SUCCESS",
        output_url: "https://cdn.example/mara.png"
      }
    });
  };

  it("renders text-to-image and hands the image back with its spec", async () => {
    succeed();
    const update = installBridge(cloudPlan([target()]));

    await executeCloudSheetPlan(
      "plan-1",
      new RendererLibrarySession().capture()
    );

    expect(post).toHaveBeenCalledWith(
      "/assets/img2img/render",
      {
        timeline_id: "cloud-sheets-1",
        sheet_token: "mara",
        sheet_name: "Mara",
        sheet_kind: "character",
        img_file_type: "png",
        render_model: "seedream_5_pro_t2i",
        render_mode: "credits",
        settings: {
          prompt: "Mara, turnaround\n\nPainterly",
          width: 1024,
          height: 1024
        }
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(update.mock.calls.map(([call]) => call.operation)).toEqual([
      "begin-cloud-sheet-submission",
      "start-cloud-sheet-render",
      "add-cloud-sheet-render"
    ]);
    expect(update.mock.calls[2]![0].payload).toEqual(
      expect.objectContaining({
        planId: "plan-1",
        executionSession: "library-session",
        token: "mara",
        outputUrl: "https://cdn.example/mara.png",
        renderSpec: { kind: "sheet", token: "mara", prompt: "Mara, turnaround" }
      })
    );
  });

  it("renders a variant through the edit sibling, its master first", async () => {
    succeed();
    ensureCloudImageAsset.mockImplementation(
      async (_api: unknown, id: string) => `cloud-${id}`
    );
    const update = installBridge(
      cloudPlan([
        target({
          token: "mara--coat",
          master_token: "mara",
          _local_reference_asset_ids: ["ref-1"]
        })
      ])
    );

    await executeCloudSheetPlan(
      "plan-1",
      new RendererLibrarySession().capture()
    );

    expect(post.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        render_model: "seedream_5_pro",
        source_asset: "cloud-master-1",
        settings: expect.objectContaining({
          input_image_id: "cloud-master-1",
          reference_images: ["cloud-ref-1"]
        })
      })
    );
    expect(update.mock.calls[2]![0].payload.renderSpec).toEqual(
      expect.objectContaining({ master_asset_id: "master-1" })
    );
  });

  it("polls a clip it already submitted instead of paying again", async () => {
    succeed();
    installBridge(
      cloudPlan(
        [target()],
        [
          {
            tool_name: "submit_img2img_batch",
            tool_args: { token: "mara" },
            status: "COMPLETED",
            result: { cloud_clip_id: "clip-0", cloud_asset_id: "asset-0" }
          }
        ]
      )
    );

    await executeCloudSheetPlan(
      "plan-1",
      new RendererLibrarySession().capture()
    );

    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith("/assets/img2img/status/clip-0", {
      signal: expect.any(AbortSignal)
    });
  });

  it("does not render a key a newer run took over from this plan", async () => {
    succeed();
    installBridge(
      cloudPlan(
        [target()],
        [
          {
            tool_name: "submit_img2img_batch",
            tool_args: { token: "mara" },
            status: "SKIPPED",
            result: { reason: "superseded", superseded_by: "plan-2" }
          },
          {
            tool_name: "poll_img2img_batch",
            tool_args: { token: "mara" },
            status: "SKIPPED",
            result: { reason: "superseded", superseded_by: "plan-2" }
          }
        ]
      )
    );

    await executeCloudSheetPlan(
      "plan-1",
      new RendererLibrarySession().capture()
    );

    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("pauses the plan with the reason when the cloud is not available", async () => {
    canRender.value = false;
    const update = installBridge(cloudPlan([target()]));

    await executeCloudSheetPlan(
      "plan-1",
      new RendererLibrarySession().capture()
    );

    expect(update).toHaveBeenCalledWith({
      projectId: "local-1",
      operation: "fail-cloud-sheet-render",
      payload: {
        planId: "plan-1",
        executionSession: "library-session",
        token: "mara",
        message: "Sign in to Mago Cloud to use this image model"
      }
    });
    expect(post).not.toHaveBeenCalled();
  });
  it("does not submit after the library changes while resolving cloud references", async () => {
    succeed();
    const plan = cloudPlan([
      target({ _local_reference_asset_ids: ["reference"] })
    ]);
    const update = installBridge(plan);
    let release!: (id: string) => void;
    ensureCloudImageAsset.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const running = executeCloudSheetPlan(
      "plan-1",
      new RendererLibrarySession().capture()
    );
    await vi.waitFor(() => expect(ensureCloudImageAsset).toHaveBeenCalled());
    plan.local_execution_session = "replacement-session";
    release("cloud-reference");
    await running;
    expect(post).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("will not execute a legacy plan without an active execution session", async () => {
    const plan: Record<string, unknown> = cloudPlan([target()]);
    delete plan.local_execution_session;
    const update = installBridge(plan);
    await executeCloudSheetPlan(
      "plan-1",
      new RendererLibrarySession().capture()
    );
    expect(ensureCloudProject).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("does not read a replacement plan when an old detached launcher starts late", async () => {
    const session = new RendererLibrarySession();
    const work = session.capture();
    await session.suspend();
    session.reset();
    const plan = cloudPlan([target()]);
    installBridge(plan);
    await executeCloudSheetPlan(plan.id, work);
    expect(window.mago?.scriptProjects.getPlan).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("stops polling without cancelling or rewriting an accepted clip", async () => {
    vi.useFakeTimers();
    try {
      succeed();
      get.mockResolvedValue({ data: { render_status: "RUNNING" } });
      const update = installBridge(cloudPlan([target()]));
      const session = new RendererLibrarySession();
      const work = session.capture();
      const running = executeCloudSheetPlan("plan-1", work);
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledExactlyOnceWith(
        "/assets/img2img/status/clip-1",
        { signal: work.signal }
      );
      expect(vi.getTimerCount()).toBe(1);
      await session.suspend();
      await running;
      expect(vi.getTimerCount()).toBe(0);
      expect(post).toHaveBeenCalledTimes(1);
      expect(update.mock.calls.map(([call]) => call.operation)).toEqual([
        "begin-cloud-sheet-submission",
        "start-cloud-sheet-render"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not register a second target after acceptance while an earlier output IPC holds the queue", async () => {
    succeed();
    const plan = cloudPlan([target(), target({ token: "coast" })]);
    const update = installBridge(plan);
    let acceptSecond!: () => void;
    const secondResponse = new Promise<void>((resolve) => {
      acceptSecond = resolve;
    });
    post.mockImplementation(async (_path, body: { sheet_token: string }) => {
      if (body.sheet_token === "coast") await secondResponse;
      return {
        data: {
          clips: [{ id: `${body.sheet_token}-clip`, asset: { id: "image" } }]
        }
      };
    });
    let finishOutput!: () => void;
    const output = new Promise<void>((resolve) => {
      finishOutput = resolve;
    });
    update.mockImplementation(async (call) => {
      if (call.operation === "add-cloud-sheet-render") await output;
      return {};
    });
    const session = new RendererLibrarySession();
    const pending = executeCloudSheetPlan(plan.id, session.capture());
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "add-cloud-sheet-render",
          payload: expect.objectContaining({ token: "mara" })
        })
      )
    );
    expect(post).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "begin-cloud-sheet-submission",
        payload: expect.objectContaining({ token: "coast" })
      })
    );
    acceptSecond();
    await Promise.resolve();
    await session.suspend();
    finishOutput();
    await pending;
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "start-cloud-sheet-render",
        payload: expect.objectContaining({ token: "coast" })
      })
    );
  });
});
