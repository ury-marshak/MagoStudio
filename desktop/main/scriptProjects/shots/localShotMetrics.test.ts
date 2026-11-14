import { describe, expect, it, vi } from "vitest";

import { LocalShotMetrics } from "./localShotMetrics";

const setup = (initial: Record<string, unknown> | null = null) => {
  let stored = initial;
  let finish!: (result: Record<string, unknown>) => void;
  const evaluate = vi.fn(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      })
  );
  const dependencies = {
    read: vi.fn(async () => stored),
    write: vi.fn(async (_id: string, value: Record<string, unknown>) => {
      stored = value;
    }),
    resolveInput: vi.fn(async () => ({
      sourcePath: "shot.mp4",
      prompt: "walk",
      durationSeconds: 5,
      referencePaths: []
    })),
    evaluate
  };
  return {
    service: new LocalShotMetrics(dependencies),
    dependencies,
    finish: (value: Record<string, unknown>) => finish(value),
    stored: () => stored
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("local shot scoring lifecycle", () => {
  it("deduplicates concurrent readers, returns pending and persists completion", async () => {
    const test = setup();
    const [a, b] = await Promise.all([
      test.service.get("video"),
      test.service.get("video")
    ]);
    expect(a.status).toBe("PENDING");
    expect(b).toEqual(a);
    expect(test.dependencies.evaluate).toHaveBeenCalledTimes(1);
    test.finish({ vid_score: 8.5, vid_pass: true });
    await vi.waitFor(() => expect(test.stored()?.status).toBe("COMPLETED"));
    expect(await test.service.get("video")).toMatchObject({
      status: "COMPLETED",
      vid_score: 8.5
    });
    expect(test.dependencies.evaluate).toHaveBeenCalledTimes(1);
  });
  it("restarts interrupted jobs and reuses completed jobs after restart", async () => {
    const interrupted = setup({ status: "PENDING" });
    await interrupted.service.get("video");
    expect(interrupted.dependencies.evaluate).toHaveBeenCalledTimes(1);
    interrupted.finish({ vid_score: 6 });
    await vi.waitFor(() =>
      expect(interrupted.stored()?.status).toBe("COMPLETED")
    );
    const restarted = setup(interrupted.stored());
    expect(await restarted.service.get("video")).toMatchObject({
      status: "COMPLETED",
      vid_score: 6
    });
    expect(restarted.dependencies.evaluate).not.toHaveBeenCalled();
  });
  it("persists evaluation failures with no fabricated score", async () => {
    const test = setup();
    test.dependencies.evaluate.mockRejectedValue(new Error("VLM missing"));
    await test.service.get("video");
    await vi.waitFor(() => expect(test.stored()?.status).toBe("FAILED"));
    expect(await test.service.get("video")).toMatchObject({
      vid_score: null,
      error: { stage: "evaluate", message: "VLM missing" }
    });
  });
  it("does not leave a pending badge if saving the result fails", async () => {
    const test = setup();
    await test.service.get("video");
    test.dependencies.write.mockRejectedValue(new Error("disk full"));
    test.finish({ vid_score: 7 });
    await vi.waitFor(async () =>
      expect(await test.service.get("video")).toMatchObject({
        status: "FAILED",
        error: { stage: "persist" }
      })
    );
  });
  it("aborts active evaluation without writing failure or waiting for the provider", async () => {
    const test = setup();
    const signal = test.service.captureSession();
    await test.service.get("video");
    expect(test.dependencies.evaluate).toHaveBeenCalledWith(
      expect.anything(),
      signal
    );
    await test.service.suspend();
    expect(signal.aborted).toBe(true);
    expect(() => test.service.get("video")).toThrow();
    test.finish({ vid_score: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.dependencies.write).toHaveBeenCalledTimes(1);
    expect(test.stored()?.status).toBe("PENDING");
  });

  it("does not start evaluation when an input resolver ignores abort", async () => {
    const test = setup();
    const input =
      deferred<Awaited<ReturnType<typeof test.dependencies.resolveInput>>>();
    test.dependencies.resolveInput.mockReturnValue(input.promise);
    await test.service.get("video");
    await test.service.suspend();
    input.resolve({
      sourcePath: "old.mp4",
      prompt: "old",
      durationSeconds: 5,
      referencePaths: []
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.dependencies.evaluate).not.toHaveBeenCalled();
    expect(test.dependencies.write).toHaveBeenCalledTimes(1);
  });

  it("suppresses a queued read after teardown and keeps replacement IDs independent", async () => {
    const test = setup();
    const read = deferred<Record<string, unknown> | null>();
    test.dependencies.read.mockReturnValueOnce(read.promise);
    const old = test.service.get("video");
    const rejected = expect(old).rejects.toThrow();
    await test.service.suspend();
    test.service.reset();
    await test.service.get("video");
    const finishNew = test.finish;
    read.resolve(null);
    await rejected;
    expect(test.dependencies.write).toHaveBeenCalledTimes(1);
    // Late cleanup from the old session cannot delete the new in-flight job.
    await test.service.get("video");
    expect(test.dependencies.evaluate).toHaveBeenCalledTimes(1);
    finishNew({ vid_score: 7 });
    await vi.waitFor(() => expect(test.stored()?.status).toBe("COMPLETED"));
  });

  it("rejects a captured old session before any replacement-library lookup", async () => {
    const test = setup();
    const signal = test.service.captureSession();
    await test.service.suspend();
    test.service.reset();
    expect(() => test.service.get("video", signal)).toThrow();
    expect(test.dependencies.read).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "COMPLETED"])(
    "drains an already issued %s database write before replacement",
    async (status) => {
      const test = setup();
      const write = deferred<void>();
      if (status === "PENDING")
        test.dependencies.write.mockReturnValueOnce(write.promise);
      const request = test.service.get("video");
      const settled = request.catch(() => undefined);
      if (status === "COMPLETED") {
        await request;
        test.dependencies.write.mockReturnValueOnce(write.promise);
        test.finish({ vid_score: 7 });
        await vi.waitFor(() =>
          expect(test.dependencies.write).toHaveBeenCalledTimes(2)
        );
      }
      let drained = false;
      const suspension = test.service.suspend().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      write.resolve();
      await suspension;
      await settled;
      expect(drained).toBe(true);
      if (status === "PENDING")
        expect(test.dependencies.evaluate).not.toHaveBeenCalled();
    }
  );

  it("cannot let a late old evaluation overwrite an identical replacement asset", async () => {
    const test = setup();
    await test.service.get("video");
    const finishNew = deferred<Record<string, unknown>>();
    // The first provider's completion is deliberately retained across reset.
    const completeOld = test.finish;
    await test.service.suspend();
    test.service.reset();
    test.dependencies.evaluate.mockReturnValueOnce(finishNew.promise);
    await test.service.get("video");
    completeOld({ vid_score: 99 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.stored()?.status).toBe("PENDING");
    finishNew.resolve({ vid_score: 4 });
    await vi.waitFor(() => expect(test.stored()?.vid_score).toBe(4));
    expect(test.dependencies.write).toHaveBeenCalledTimes(3);
  });

  it("preserves PENDING for restart after an aborted provider rejection", async () => {
    const test = setup();
    let fail!: (error: Error) => void;
    test.dependencies.evaluate.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      })
    );
    await test.service.get("video");
    await test.service.suspend();
    fail(new DOMException("Cancelled", "AbortError"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.stored()?.status).toBe("PENDING");
    const restarted = setup(test.stored());
    await restarted.service.get("video");
    expect(restarted.dependencies.evaluate).toHaveBeenCalledTimes(1);
    restarted.finish({ vid_score: 6 });
    await vi.waitFor(() =>
      expect(restarted.stored()?.status).toBe("COMPLETED")
    );
  });
});
