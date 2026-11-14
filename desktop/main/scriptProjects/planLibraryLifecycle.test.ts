import { afterEach, describe, expect, it, vi } from "vitest";

import type { VisionGenerator } from "../vlm/visionGenerator";

import { ComfyScriptProjectClient } from "./comfyScriptProjectClient";
import { LocalScriptProjectService } from "./localScriptProjectService";

type Value = Record<string, unknown>;
type Control = {
  projectId: string;
  planId: string;
  cancelled: boolean;
  abortController: AbortController;
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const setup = (external?: VisionGenerator) => {
  let state: Value = { keys: [], shots: [] };
  const plans = new Map<string, Value>();
  const projects = {
    get: vi.fn(async () => ({ origin: "local", type: "script_to_shots" }))
  };
  const snapshots = {
    get: vi.fn(async () => ({
      state: structuredClone(state),
      scriptVersions: { versions: [] },
      planDetails: Object.fromEntries(plans)
    })),
    put: vi.fn(async (input: { state?: Value }) => {
      if (input.state) state = structuredClone(input.state);
    }),
    putPlan: vi.fn(async (_project: string, id: string, value: Value) => {
      plans.set(id, structuredClone(value));
    }),
    getPlan: vi.fn(async (id: string) => plans.get(id)),
    resolveMediaPath: vi.fn(async () => "image.png"),
    storeRemoteMedia: vi.fn()
  };
  const jobs = { cancel: vi.fn(), submit: vi.fn(), refresh: vi.fn() };
  const service = new LocalScriptProjectService(
    projects as never,
    snapshots as never,
    async () => "http://127.0.0.1:8188",
    undefined,
    undefined,
    undefined,
    undefined,
    async () => external ?? null,
    jobs as never
  );
  const internals = service as unknown as {
    startRun: (
      project: string,
      plan: string,
      task: (control: Control) => Promise<void>
    ) => void;
    startOrQueueRun: (
      project: string,
      plan: string,
      task: (control: Control) => Promise<void>
    ) => void;
    withProjectStateWrite: (
      project: string,
      write: () => Promise<void>
    ) => Promise<void>;
    waitForRenderer: (project: string, plan: string, queue?: boolean) => void;
    projectRuns: Map<string, { control: Control; promise: Promise<void> }>;
    renderSheets: (
      input: Value,
      targets: Value[],
      plan: Value,
      control: Control
    ) => Promise<void>;
  };
  return {
    service,
    internals,
    projects,
    snapshots,
    plans,
    jobs,
    state: () => state,
    setState: (value: Value) => {
      state = value;
    }
  };
};
afterEach(() => vi.restoreAllMocks());

describe("Director plan library ownership", () => {
  it.each([
    "start-cloud-sheet-render",
    "add-cloud-sheet-render",
    "fail-cloud-sheet-render"
  ] as const)(
    "refuses a stale renderer %s callback even after a reused plan is resumed",
    async (operation) => {
      const test = setup();
      test.setState({
        keys: [{ token: "hero", name: "Hero", prompt: "Hero", images: [] }],
        shots: []
      });
      const result = await test.service.generateSheets({
        projectId: "project",
        isDryRun: false,
        settings: { render_model: "gpt_image_2_t2i" }
      });
      const id = String(result.plan_id);
      const oldSession = (await test.service.getPlan(id))
        ?.local_execution_session;
      expect(oldSession).toEqual(expect.any(String));
      expect(test.plans.get(id)).not.toHaveProperty("local_execution_session");
      await test.service.suspendPlans();
      test.service.resetPlans();
      await test.service.getPlan(id);
      await test.service.resumePlan(id);
      const newSession = (await test.service.getPlan(id))
        ?.local_execution_session;
      expect(newSession).not.toBe(oldSession);
      const writes = test.snapshots.putPlan.mock.calls.length;
      await expect(
        test.service.update({
          projectId: "project",
          operation,
          payload: {
            planId: id,
            token: "hero",
            executionSession: oldSession,
            outputUrl: "https://mock/old.png"
          }
        })
      ).rejects.toThrow("expired library execution");
      expect(test.snapshots.storeRemoteMedia).not.toHaveBeenCalled();
      expect(test.snapshots.putPlan).toHaveBeenCalledTimes(writes);
      await test.service.update({
        projectId: "project",
        operation: "start-cloud-sheet-render",
        payload: {
          planId: id,
          token: "hero",
          executionSession: newSession,
          cloudClipId: "accepted",
          cloudAssetId: "asset"
        }
      });
      await test.service.suspendPlans();
    }
  );

  it("drops queued runs without cancelling remote jobs or waiting for inference", async () => {
    const test = setup();
    const provider = deferred<void>();
    const queued = vi.fn(async () => {});
    let control!: Control;
    await test.service.inLibrary(async () => {
      test.internals.startRun("project", "plan", async (running) => {
        control = running;
        await provider.promise;
      });
      test.internals.startOrQueueRun("project", "queued", queued);
    });
    await test.service.suspendPlans();
    expect(control.cancelled).toBe(true);
    expect(control.abortController.signal.aborted).toBe(true);
    expect(test.jobs.cancel).not.toHaveBeenCalled();
    provider.resolve();
    await flush();
    expect(queued).not.toHaveBeenCalled();
  });

  it("isolates late run cleanup and reused project/plan IDs in a replacement session", async () => {
    const test = setup();
    const old = deferred<void>();
    const fresh = deferred<void>();
    const queued = vi.fn(async () => {});
    await test.service.inLibrary(async () => {
      test.internals.startRun("project", "same-plan", () => old.promise);
    });
    await test.service.suspendPlans();
    test.service.resetPlans();
    await test.service.inLibrary(async () => {
      test.internals.startRun("project", "same-plan", () => fresh.promise);
      test.internals.startOrQueueRun("project", "new-queued", queued);
    });
    old.resolve();
    await flush();
    expect(test.internals.projectRuns.get("project")?.control.planId).toBe(
      "same-plan"
    );
    expect(queued).not.toHaveBeenCalled();
    fresh.resolve();
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
  });

  it("blocks a late task's snapshot write even when the task ignores its controller", async () => {
    const test = setup();
    const provider = deferred<void>();
    await test.service.inLibrary(async () => {
      test.internals.startRun("project", "plan", async () => {
        await provider.promise;
        await test.service.putSnapshot({
          projectId: "project",
          state: { wrong: true }
        });
      });
    });
    await test.service.suspendPlans();
    test.service.resetPlans();
    provider.resolve();
    await flush();
    expect(test.snapshots.put).not.toHaveBeenCalled();
    expect(test.state()).not.toMatchObject({ wrong: true });
  });

  it("releases renderer waiters but cannot dispatch their queued successors", async () => {
    const test = setup();
    const queued = vi.fn(async () => {});
    await test.service.inLibrary(async () => {
      test.internals.waitForRenderer("project", "cloud-sheet");
      test.internals.startOrQueueRun("project", "queued", queued);
    });
    const running = test.internals.projectRuns.get("project")!.promise;
    const rejected = expect(running).rejects.toThrow();
    await test.service.suspendPlans();
    await rejected;
    expect(queued).not.toHaveBeenCalled();
    expect(test.jobs.cancel).not.toHaveBeenCalled();
  });

  it("guards callbacks queued behind a prior project write and isolates new queues", async () => {
    const test = setup();
    const held = deferred<void>();
    const callback = vi.fn(async () => {});
    const old = test.service.inLibrary(async () => {
      const first = test.internals.withProjectStateWrite(
        "project",
        () => held.promise
      );
      const second = test.internals.withProjectStateWrite("project", callback);
      await Promise.all([first, second]);
    });
    const rejected = expect(old).rejects.toThrow();
    await flush();
    await test.service.suspendPlans();
    test.service.resetPlans();
    const replacement = vi.fn(async () => {});
    await test.service.inLibrary(() =>
      test.internals.withProjectStateWrite("project", replacement)
    );
    held.resolve();
    await rejected;
    expect(callback).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it("drains an issued snapshot write before reset", async () => {
    const test = setup();
    const write = deferred<void>();
    test.snapshots.put.mockReturnValueOnce(write.promise);
    const pending = test.service.putSnapshot({
      projectId: "project",
      state: {}
    });
    const rejected = expect(pending).rejects.toThrow();
    let drained = false;
    const suspension = test.service.suspendPlans().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    expect(() => test.service.resetPlans()).toThrow();
    write.resolve();
    await suspension;
    await rejected;
    test.service.resetPlans();
  });

  it.each(["{broken", '{"title":"late valid data"}'])(
    "aborts casting without repairing or persisting late output %s",
    async (text) => {
      const response = deferred<{ text: string; model: string }>();
      const generate = vi.fn<VisionGenerator>(() => response.promise);
      const test = setup(generate);
      const result = await test.service.cast({
        projectId: "project",
        script: "INT. ROOM - DAY\nA person enters.",
        maxShots: 1,
        isAtomicShotsRequested: false
      });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      const writes = test.snapshots.putPlan.mock.calls.length;
      await test.service.suspendPlans();
      test.service.resetPlans();
      response.resolve({ text, model: "mock" });
      await flush();
      expect(generate.mock.calls[0]![0].signal?.aborted).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(test.snapshots.putPlan).toHaveBeenCalledTimes(writes);
      expect((await test.service.getPlan(result.plan_id))?.status).toBe(
        "PAUSED"
      );
    }
  );

  it("rejects direct project entry points while suspended", async () => {
    const test = setup();
    await test.service.suspendPlans();
    await expect(test.service.getSnapshot("project")).rejects.toThrow();
    await expect(test.service.getPlan("plan")).rejects.toThrow();
    await expect(
      test.service.generateSheets({ projectId: "project", isDryRun: true })
    ).rejects.toThrow();
    expect(test.projects.get).not.toHaveBeenCalled();
    expect(test.snapshots.get).not.toHaveBeenCalled();
  });

  it("prevents detached body-plan classification from writing after teardown", async () => {
    const test = setup();
    const response = deferred<string>();
    const classifier = vi
      .spyOn(ComfyScriptProjectClient.prototype, "runVideoPrompt")
      .mockReturnValue(response.promise);
    const key = {
      token: "hero",
      name: "Hero",
      kind: "character",
      prompt: "courier",
      seed_description: "seed",
      effective_asset_id: "image",
      images: [
        {
          asset_id: "image",
          description: "hero",
          description_source: "vlm",
          has_description: true
        }
      ]
    };
    test.setState({ keys: [key], shots: [] });
    const plan = {
      id: "sheet",
      steps: [
        {
          tool_name: "poll_img2img_batch",
          tool_args: { token: "hero" },
          status: "COMPLETED",
          result: { asset_ids: ["image"] }
        }
      ]
    };
    await test.service.inLibrary(() =>
      test.internals.renderSheets(
        {
          projectId: "project",
          settings: { render_model: "qwen_image_2512_local" }
        },
        [key],
        plan,
        {
          projectId: "project",
          planId: "sheet",
          cancelled: false,
          abortController: new AbortController()
        }
      )
    );
    await vi.waitFor(() => expect(classifier).toHaveBeenCalledTimes(1));
    const writes = test.snapshots.put.mock.calls.length;
    await test.service.suspendPlans();
    test.service.resetPlans();
    response.resolve('{"body_plan":"upright"}');
    await flush();
    expect(test.snapshots.put).toHaveBeenCalledTimes(writes);
    expect(test.state()).not.toMatchObject({
      keys: [expect.objectContaining({ body_plan_auto: "upright" })]
    });
  });
});
