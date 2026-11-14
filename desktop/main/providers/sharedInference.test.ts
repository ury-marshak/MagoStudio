import { describe, expect, it, vi } from "vitest";

import { SharedInference, waitForInference } from "./sharedInference";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("SharedInference", () => {
  it("shares one call and lets one consumer leave without aborting another", async () => {
    const shared = new SharedInference<string>();
    const work = deferred<string>();
    const start = vi.fn((_signal: AbortSignal) => work.promise);
    const first = new AbortController();
    const second = new AbortController();
    const a = shared.run("image", start, first.signal);
    const b = shared.run("image", start, second.signal);
    const cancelled = expect(a).rejects.toThrow("cancel first");
    await Promise.resolve();
    first.abort(new Error("cancel first"));
    await cancelled;
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].aborted).toBe(false);
    work.resolve("caption");
    await expect(b).resolves.toBe("caption");
  });

  it("aborts on the last consumer, tolerates late failure and permits a fresh request", async () => {
    const shared = new SharedInference<string>();
    const work = deferred<string>();
    const start = vi.fn((_signal: AbortSignal) => work.promise);
    const controller = new AbortController();
    const result = shared.run("image", start, controller.signal);
    const cancelled = expect(result).rejects.toThrow();
    await Promise.resolve();
    controller.abort();
    await cancelled;
    expect(start.mock.calls[0]![0].aborted).toBe(true);
    work.reject(new Error("late provider failure"));
    await expect(
      shared.run("image", async () => "new", new AbortController().signal)
    ).resolves.toBe("new");
  });

  it("does not start an already-cancelled consumer", async () => {
    const start = vi.fn();
    await expect(
      new SharedInference().run("image", start, AbortSignal.abort())
    ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  it("removes wait listeners after success and failure", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      waitForInference(Promise.resolve(1), controller.signal)
    ).resolves.toBe(1);
    await expect(
      waitForInference(Promise.reject(new Error("failed")), controller.signal)
    ).rejects.toThrow("failed");
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
