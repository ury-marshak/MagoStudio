import { afterEach, describe, expect, it, vi } from "vitest";

import { ScriptProjectSnapshotRepository } from "../database/scriptProjectSnapshotRepository";
import { ProfileIoDrain } from "../providers/profileIoDrain";
import type { VisionGenerator } from "../vlm/visionGenerator";

import { ComfyScriptProjectClient } from "./comfyScriptProjectClient";
import { LocalScriptProjectService } from "./localScriptProjectService";

type Value = Record<string, unknown>;
type Control = {
  projectId: string;
  planId: string;
  cancelled: boolean;
  abortController: AbortController;
  signal: AbortSignal;
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
    putPlan: vi.fn<ScriptProjectSnapshotRepository["putPlan"]>(
      async (_project, id, value) => {
        plans.set(id, structuredClone(value));
      }
    ),
    getPlan: vi.fn(async (id: string) => plans.get(id)),
    resolveMediaPath: vi.fn(async () => "image.png"),
    storeRemoteMedia: vi.fn()
  };
  const jobs = { cancel: vi.fn(), submit: vi.fn(), refresh: vi.fn() };
  const profileIo = new ProfileIoDrain();
  const service = new LocalScriptProjectService(
    projects as never,
    snapshots as never,
    async () => "http://127.0.0.1:8188",
    undefined,
    undefined,
    undefined,
    undefined,
    async () => external ?? null,
    jobs as never,
    undefined,
    undefined,
    undefined,
    profileIo
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
    profileIo,
    state: () => state,
    setState: (value: Value) => {
      state = value;
    }
  };
};

const setupCloudSheet = async () => {
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
  const planId = String(result.plan_id);
  const payload = {
    planId,
    token: "hero",
    executionSession: (await test.service.getPlan(planId))
      ?.local_execution_session
  };
  const update = (
    operation: Parameters<LocalScriptProjectService["update"]>[0]["operation"],
    profile?: AbortSignal,
    extra?: Value
  ) =>
    test.service.update(
      { projectId: "project", operation, payload: { ...payload, ...extra } },
      undefined,
      profile
    );
  return { ...test, planId, update };
};

afterEach(() => vi.restoreAllMocks());

describe("Cloud sheet account checkpoint ownership", () => {
  it("does not admit a submission marker after retirement during the step read", async () => {
    const test = await setupCloudSheet();
    const profile = new AbortController();
    const readStarted = deferred<void>();
    const finishRead = deferred<Value>();
    const plan = test.plans.get(test.planId)!;
    test.snapshots.getPlan
      .mockResolvedValueOnce(plan)
      .mockImplementationOnce(() => {
        readStarted.resolve();
        return finishRead.promise;
      });
    test.snapshots.putPlan.mockClear();
    const begin = test.update("begin-cloud-sheet-submission", profile.signal);
    const rejected = expect(begin).rejects.toBeInstanceOf(DOMException);
    await readStarted.promise;
    profile.abort();
    finishRead.resolve(plan);
    await rejected;
    expect(test.snapshots.putPlan).not.toHaveBeenCalled();
    await expect(
      test.update("begin-cloud-sheet-submission", new AbortController().signal)
    ).resolves.toMatchObject({ status: "RUNNING" });
  });

  it("does not write a marker after retirement during the repository read", async () => {
    const test = await setupCloudSheet();
    const profile = new AbortController();
    const readStarted = deferred<void>();
    const finishRead = deferred<Value[]>();
    const update = vi.fn();
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              readStarted.resolve();
              return finishRead.promise;
            }
          })
        })
      }),
      update
    };
    const repository = new ScriptProjectSnapshotRepository(
      { get: () => database } as never,
      async () => "mock-library",
      { allowedHosts: [] }
    );
    test.snapshots.putPlan.mockImplementationOnce(repository.putPlan);
    const begin = test.update("begin-cloud-sheet-submission", profile.signal);
    const rejected = expect(begin).rejects.toBeInstanceOf(DOMException);
    await readStarted.promise;
    profile.abort();
    finishRead.resolve([
      {
        projectId: "project",
        stateJson: null,
        scriptVersionsJson: null,
        planDetailsJson: JSON.stringify(Object.fromEntries(test.plans)),
        cutJson: null
      }
    ]);
    await rejected;
    expect(update).not.toHaveBeenCalled();
  });

  it("drains an issued marker, keeps uncertainty, and still records accepted IDs", async () => {
    const test = await setupCloudSheet();
    const profile = new AbortController();
    const committed = deferred<void>();
    const finishWrite = deferred<void>();
    test.snapshots.putPlan.mockImplementationOnce(
      async (_project, id, plan) => {
        test.plans.set(id, plan);
        committed.resolve();
        await finishWrite.promise;
      }
    );
    const begin = test.update("begin-cloud-sheet-submission", profile.signal);
    const rejected = expect(begin).rejects.toBeInstanceOf(DOMException);
    await committed.promise;
    profile.abort();
    let drained = false;
    const drain = test.profileIo.drainRetired().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    finishWrite.resolve();
    await drain;
    await rejected;
    await expect(
      test.update("begin-cloud-sheet-submission", new AbortController().signal)
    ).rejects.toThrow("already recorded or may have been accepted");
    await test.update("start-cloud-sheet-render", profile.signal, {
      cloudClipId: "accepted",
      cloudAssetId: "asset"
    });
    expect(test.plans.get(test.planId)?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_name: "submit_img2img_batch",
          status: "COMPLETED",
          result: expect.objectContaining({
            cloud_clip_id: "accepted",
            cloud_asset_id: "asset"
          })
        })
      ])
    );
  });

  const image = {
    id: "image",
    url: "mago-media://script-project/image",
    isImage: true
  };
  const output = { outputUrl: "https://mock/output.png" };

  it("does not admit output completion after retirement during the snapshot read", async () => {
    const test = await setupCloudSheet();
    const profile = new AbortController();
    const readStarted = deferred<void>();
    const finishRead =
      deferred<Awaited<ReturnType<typeof test.snapshots.get>>>();
    const snapshot = await test.snapshots.get();
    test.snapshots.storeRemoteMedia.mockImplementationOnce(async () => {
      test.snapshots.get.mockImplementationOnce(() => {
        readStarted.resolve();
        return finishRead.promise;
      });
      return image;
    });
    test.snapshots.putPlan.mockClear();
    const completion = test.update(
      "add-cloud-sheet-render",
      profile.signal,
      output
    );
    const rejected = expect(completion).rejects.toBeInstanceOf(DOMException);
    await readStarted.promise;
    profile.abort();
    await test.profileIo.drainRetired();
    finishRead.resolve(snapshot);
    await rejected;
    expect(test.snapshots.storeRemoteMedia).toHaveBeenCalledWith(
      "project",
      output.outputUrl,
      profile.signal
    );
    expect(test.snapshots.put).not.toHaveBeenCalled();
    expect(test.snapshots.putPlan).not.toHaveBeenCalled();
  });

  it("drains admitted output completion through the final plan save", async () => {
    const test = await setupCloudSheet();
    const profile = new AbortController();
    const writingSnapshot = deferred<void>();
    const finishSnapshot = deferred<void>();
    const writingFinalPlan = deferred<void>();
    const finishFinalPlan = deferred<void>();
    test.snapshots.storeRemoteMedia.mockResolvedValueOnce(image);
    test.snapshots.put.mockImplementationOnce(async ({ state }) => {
      writingSnapshot.resolve();
      await finishSnapshot.promise;
      test.setState(state!);
    });
    test.snapshots.putPlan.mockImplementation(async (_project, id, plan) => {
      if (plan.status === "COMPLETED") {
        writingFinalPlan.resolve();
        await finishFinalPlan.promise;
      }
      test.plans.set(id, plan);
    });
    const completion = test.update(
      "add-cloud-sheet-render",
      profile.signal,
      output
    );
    await writingSnapshot.promise;
    profile.abort();
    let drained = false;
    const drain = test.profileIo.drainRetired().then(() => {
      drained = true;
    });
    finishSnapshot.resolve();
    await writingFinalPlan.promise;
    expect(drained).toBe(false);
    expect(test.snapshots.put).toHaveBeenCalledWith(
      expect.objectContaining({ metadataOnly: true })
    );
    finishFinalPlan.resolve();
    await drain;
    await expect(completion).resolves.toMatchObject({
      effective_asset_id: "image"
    });
    expect(test.plans.get(test.planId)).toMatchObject({
      status: "COMPLETED",
      steps: expect.arrayContaining([
        expect.objectContaining({
          tool_name: "poll_img2img_batch",
          status: "COMPLETED"
        })
      ])
    });
  });
});

describe("Director plan library ownership", () => {
  it.each([
    "begin-cloud-sheet-submission",
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

  it.each(["library", "inference profile"])(
    "prevents detached body-plan classification from writing after %s retirement",
    async (scope) => {
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
      const abortController = new AbortController();
      const profile =
        scope === "inference profile" ? new AbortController() : undefined;
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
            abortController,
            signal: abortController.signal,
            ...(profile ? { profile: profile.signal } : {})
          }
        )
      );
      await vi.waitFor(() => expect(classifier).toHaveBeenCalledTimes(1));
      const writes = test.snapshots.put.mock.calls.length;
      if (profile) profile.abort();
      else {
        await test.service.suspendPlans();
        test.service.resetPlans();
      }
      response.resolve('{"body_plan":"upright"}');
      await flush();
      expect(test.snapshots.put).toHaveBeenCalledTimes(writes);
      expect(test.state()).not.toMatchObject({
        keys: [expect.objectContaining({ body_plan_auto: "upright" })]
      });
    }
  );
});
