import { describe, expect, it, vi } from "vitest";

import { LocalScriptProjectService } from "./localScriptProjectService";

type RecordValue = Record<string, unknown>;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const initialState = () => ({
  keys: [
    {
      token: "hero",
      kind: "character",
      name: "Hero",
      enabled: true,
      description: "casting seed",
      seed_description: "casting seed",
      effective_asset_id: "image",
      effective_source: "render",
      images: [
        {
          asset_id: "image",
          source: "render",
          description: null,
          has_description: false
        }
      ]
    }
  ],
  shots: []
});
const setup = () => {
  let state: RecordValue = initialState();
  const projects = {
    get: vi.fn(async () => ({ origin: "local", type: "script_to_shots" })),
    resolveMediaPath: vi.fn(async () => "uploaded.png")
  };
  const snapshots = {
    get: vi.fn(async () => ({ state: structuredClone(state) })),
    resolveMediaPath: vi.fn(async () => "image.png"),
    put: vi.fn(async (input: { state?: RecordValue }) => {
      if (input.state) state = structuredClone(input.state);
    }),
    putPlan: vi.fn(
      async (_project: string, _plan: string, _value: RecordValue) => {}
    )
  };
  const describeImage =
    vi.fn<
      (path: string, kind: string, signal?: AbortSignal) => Promise<string>
    >();
  const jobs = { cancel: vi.fn(), submit: vi.fn(), refresh: vi.fn() };
  const service = new LocalScriptProjectService(
    projects as never,
    snapshots as never,
    async () => "unused",
    undefined,
    describeImage,
    undefined,
    undefined,
    undefined,
    jobs as never
  );
  // Exercise background callers as well as public update without adding test-only production APIs.
  const background = service as unknown as {
    renderSheets: (
      input: { projectId: string; settings: { render_model: string } },
      keys: RecordValue[],
      plan: RecordValue,
      control: {
        planId: string;
        projectId: string;
        cancelled: boolean;
        abortController: AbortController;
        signal: AbortSignal;
      }
    ) => Promise<void>;
    requestSheetDescription: (
      project: string,
      token: string,
      asset: string | undefined,
      overwrite: boolean,
      required: boolean,
      signal?: AbortSignal
    ) => Promise<RecordValue>;
    ensureReferenceDescriptions: (
      project: string,
      references: RecordValue[],
      signal: AbortSignal
    ) => Promise<void>;
    withProjectStateWrite: (
      project: string,
      write: () => Promise<void>
    ) => Promise<void>;
  };
  const request = (signal?: AbortSignal, overwrite = false, required = true) =>
    background.requestSheetDescription(
      "project",
      "hero",
      "image",
      overwrite,
      required,
      signal
    );
  const update = (signal?: AbortSignal) =>
    service.update(
      {
        projectId: "project",
        operation: "describe-sheet",
        payload: { token: "hero", assetId: "image" }
      },
      signal
    );
  return {
    service,
    projects,
    snapshots,
    jobs,
    describeImage,
    background,
    request,
    update,
    state: () => state,
    replace: () => {
      state = initialState();
    }
  };
};

describe("sheet-plan description cancellation boundary", () => {
  const run = (test: ReturnType<typeof setup>, controller: AbortController) =>
    test.background.renderSheets(
      {
        projectId: "project",
        settings: { render_model: "fal_nano_banana_2_1" }
      },
      [],
      {
        id: "plan",
        steps: [
          {
            tool_name: "poll_img2img_batch",
            status: "COMPLETED",
            tool_args: { token: "hero" },
            result: { asset_ids: ["image"] }
          }
        ]
      },
      {
        projectId: "project",
        planId: "plan",
        cancelled: false,
        abortController: controller,
        signal: controller.signal
      }
    );

  it.each(["plan", "library"])(
    "does not complete or pause a plan after %s teardown during description",
    async (scope) => {
      const test = setup();
      const inference = deferred<string>();
      test.describeImage.mockReturnValue(inference.promise);
      const controller = new AbortController();
      const running = run(test, controller);
      await vi.waitFor(() =>
        expect(test.describeImage).toHaveBeenCalledTimes(1)
      );
      if (scope === "library") await test.service.suspendDescriptions();
      else controller.abort();
      await running;
      expect(test.snapshots.putPlan).toHaveBeenCalledTimes(1);
      expect(test.snapshots.putPlan.mock.calls[0]![2]).toMatchObject({
        status: "RUNNING"
      });
      inference.resolve("late");
      await flush();
      expect(test.snapshots.put).not.toHaveBeenCalled();
      expect(test.jobs.cancel).not.toHaveBeenCalled();
      expect(test.jobs.submit).not.toHaveBeenCalled();
      expect(test.jobs.refresh).not.toHaveBeenCalled();
    }
  );

  it("does not convert a provider AbortError into successful optional captions", async () => {
    const test = setup();
    test.describeImage.mockRejectedValue(
      new DOMException("provider cancelled", "AbortError")
    );
    await run(test, new AbortController());
    expect(test.snapshots.putPlan).toHaveBeenLastCalledWith(
      "project",
      "plan",
      expect.objectContaining({ status: "PAUSED" })
    );
    expect(test.snapshots.put).not.toHaveBeenCalled();
    expect(test.jobs.cancel).not.toHaveBeenCalled();
    expect(test.jobs.submit).not.toHaveBeenCalled();
  });
});

describe("Director sheet description ownership", () => {
  it("allows another request after last-consumer cancellation even if the provider never settles", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage
      .mockReturnValueOnce(inference.promise)
      .mockResolvedValue("new attempt");
    const caller = new AbortController();
    const old = test.request(caller.signal);
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    caller.abort();
    await rejected;
    expect(await test.request()).toMatchObject({ description: "new attempt" });
    expect(test.describeImage).toHaveBeenCalledTimes(2);
    inference.resolve("late old output");
    await flush();
    expect(test.snapshots.put).toHaveBeenCalledTimes(1);
  });

  it("shares inference between required and optional consumers; one cancellation keeps the other alive", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage.mockReturnValue(inference.promise);
    const caller = new AbortController();
    const first = test.request(caller.signal);
    const rejected = expect(first).rejects.toThrow();
    const second = test.request(undefined, false, false);
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    caller.abort();
    await rejected;
    const signal = test.describeImage.mock.calls[0]![2]!;
    expect(signal.aborted).toBe(false);
    inference.resolve("visible hero");
    expect(await second).toMatchObject({ description: "visible hero" });
    expect(test.snapshots.put).toHaveBeenCalledTimes(1);
  });

  it("aborts the provider when the last consumer leaves and rejects late valid output", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage.mockReturnValue(inference.promise);
    const caller = new AbortController();
    const request = test.request(caller.signal, false, false);
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    caller.abort();
    await rejected;
    expect(test.describeImage.mock.calls[0]![2]!.aborted).toBe(true);
    inference.resolve("too late");
    await flush();
    expect(test.snapshots.put).not.toHaveBeenCalled();
  });

  it.each(["valid", "empty", "failure"])(
    "suspends promptly with a late %s provider response and reused IDs",
    async (response) => {
      const test = setup();
      const inference = deferred<string>();
      test.describeImage
        .mockReturnValueOnce(inference.promise)
        .mockResolvedValue("new library hero");
      const old = test.update();
      const rejected = expect(old).rejects.toThrow();
      await vi.waitFor(() =>
        expect(test.describeImage).toHaveBeenCalledTimes(1)
      );
      await test.service.suspendDescriptions();
      await rejected;
      test.replace();
      test.service.resetDescriptions();
      if (response === "failure") inference.reject(new Error("transport"));
      else inference.resolve(response === "valid" ? "old library hero" : "");
      await flush();
      expect(test.snapshots.put).not.toHaveBeenCalled();
      await test.update();
      expect(test.state()).toMatchObject({
        keys: [{ description: "new library hero" }]
      });
    }
  );

  it("does not retarget a public request suspended during its project lookup", async () => {
    const test = setup();
    const lookup = deferred<{ origin: string; type: string }>();
    test.projects.get.mockReturnValueOnce(lookup.promise);
    const old = test.update();
    const rejected = expect(old).rejects.toThrow();
    await test.service.suspendDescriptions();
    test.service.resetDescriptions();
    lookup.resolve({ origin: "local", type: "script_to_shots" });
    await rejected;
    expect(test.describeImage).not.toHaveBeenCalled();
    expect(test.snapshots.get).not.toHaveBeenCalled();
  });

  it("suppresses queued snapshot resolution after teardown", async () => {
    const test = setup();
    const read = deferred<{ state: RecordValue }>();
    test.snapshots.get.mockReturnValueOnce(read.promise);
    const old = test.request();
    const rejected = expect(old).rejects.toThrow();
    await test.service.suspendDescriptions();
    test.service.resetDescriptions();
    read.resolve({ state: initialState() });
    await rejected;
    expect(test.describeImage).not.toHaveBeenCalled();
    expect(test.snapshots.put).not.toHaveBeenCalled();
  });

  it("cancels a queued overwrite without waiting for an unrelated consumer", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage.mockReturnValue(inference.promise);
    const first = test.request();
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    const caller = new AbortController();
    const overwrite = test.request(caller.signal, true);
    const rejected = expect(overwrite).rejects.toThrow();
    await flush();
    caller.abort();
    await rejected;
    expect(test.describeImage.mock.calls[0]![2]!.aborted).toBe(false);
    inference.resolve("original");
    await first;
    expect(test.describeImage).toHaveBeenCalledTimes(1);
    expect(test.snapshots.put).toHaveBeenCalledTimes(1);
  });

  it("serializes overwrite after an earlier attempt and permits retry after transport failure", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage
      .mockReturnValueOnce(inference.promise)
      .mockResolvedValue("retry");
    const optional = test.request(undefined, false, false);
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    const overwrite = test.request(undefined, true);
    await flush();
    expect(test.describeImage).toHaveBeenCalledTimes(1);
    inference.reject(new Error("transport"));
    await optional;
    expect(await overwrite).toMatchObject({ description: "retry" });
    expect(test.describeImage).toHaveBeenCalledTimes(2);
  });

  it("keeps required failure separate from optional fallback for a shared empty response", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage.mockReturnValue(inference.promise);
    const required = test.request();
    const failure = expect(required).rejects.toThrow(
      "Could not describe this image"
    );
    const optional = test.request(undefined, false, false);
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    inference.resolve("");
    await failure;
    expect(await optional).toMatchObject({ description: "casting seed" });
    expect(test.snapshots.put).not.toHaveBeenCalled();
  });

  it("never turns an AbortError into the casting-description fallback", async () => {
    const test = setup();
    test.describeImage.mockRejectedValue(
      new DOMException("cancelled", "AbortError")
    );
    await expect(
      test.background.ensureReferenceDescriptions(
        "project",
        [{ token: "hero", asset_id: "image" }],
        new AbortController().signal
      )
    ).rejects.toThrow("cancelled");
    expect(test.snapshots.put).not.toHaveBeenCalled();
  });

  it("stops sequential reference description after its plan is cancelled", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage.mockReturnValue(inference.promise);
    const caller = new AbortController();
    const request = test.background.ensureReferenceDescriptions(
      "project",
      [
        { token: "hero", asset_id: "image" },
        { token: "hero", asset_id: "next" }
      ],
      caller.signal
    );
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    caller.abort();
    await rejected;
    inference.resolve("late");
    await flush();
    expect(test.describeImage).toHaveBeenCalledTimes(1);
    expect(test.snapshots.put).not.toHaveBeenCalled();
  });

  it("rechecks cancellation before a queued final state write", async () => {
    const test = setup();
    const block = deferred<void>();
    const held = test.background.withProjectStateWrite(
      "project",
      () => block.promise
    );
    test.describeImage.mockResolvedValue("hero");
    const request = test.request();
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    await flush();
    await test.service.suspendDescriptions();
    await rejected;
    test.replace();
    test.service.resetDescriptions();
    block.resolve();
    await held;
    await flush();
    expect(test.snapshots.put).not.toHaveBeenCalled();
  });

  it("drains an issued final write but not inference before database replacement", async () => {
    const test = setup();
    const write = deferred<void>();
    test.snapshots.put.mockReturnValueOnce(write.promise);
    test.describeImage.mockResolvedValue("hero");
    const request = test.request();
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(test.snapshots.put).toHaveBeenCalledTimes(1));
    let drained = false;
    const suspension = test.service.suspendDescriptions().then(() => {
      drained = true;
    });
    await rejected;
    expect(drained).toBe(false);
    write.resolve();
    await suspension;
    expect(drained).toBe(true);
  });

  it("does not replace a user-authored caption with a late non-overwrite description", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage.mockReturnValue(inference.promise);
    const request = test.request();
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    await test.service.update({
      projectId: "project",
      operation: "edit-image-description",
      payload: { assetId: "image", description: "user caption" }
    });
    inference.resolve("generated caption");
    expect(await request).toMatchObject({
      images: [
        expect.objectContaining({
          description: "user caption",
          description_source: "user"
        })
      ]
    });
    expect(test.snapshots.put).toHaveBeenCalledTimes(1);
  });

  it("does not swallow upload-description cancellation as successful image attachment", async () => {
    const test = setup();
    const inference = deferred<string>();
    test.describeImage.mockReturnValue(inference.promise);
    const request = test.service.update({
      projectId: "project",
      operation: "add-sheet-image",
      payload: { token: "hero", assetId: "upload" }
    });
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(test.describeImage).toHaveBeenCalledTimes(1));
    await test.service.suspendDescriptions();
    await rejected;
    inference.resolve("late caption");
    await flush();
    expect(test.snapshots.put).toHaveBeenCalledTimes(1);
  });
});
