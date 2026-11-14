import { afterEach, describe, expect, it, vi } from "vitest";

import { cancellableInference } from "./cancellableInference";

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn(async () => {}) }));
vi.mock("./localDesktop", () => ({
  getLocalDesktopApi: () => ({ vlm: { cancel } })
}));

afterEach(() => vi.clearAllMocks());

describe("cancellableInference", () => {
  it("sends only an opaque ID and cancels that ID on abort", async () => {
    let finish!: (value: string) => void;
    const invoke = vi.fn(
      (_id?: string) =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const controller = new AbortController();
    const result = cancellableInference(invoke, controller.signal);
    const id = invoke.mock.calls[0]![0];
    expect(typeof id).toBe("string");
    controller.abort(new Error("left editor"));
    expect(cancel).toHaveBeenCalledExactlyOnceWith(id);
    finish("late result");
    await expect(result).rejects.toThrow("left editor");
  });

  it("does not invoke after a pre-start abort", async () => {
    const invoke = vi.fn();
    await expect(
      cancellableInference(invoke, AbortSignal.abort())
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cleans up its listener after success or transport failure", async () => {
    const controller = new AbortController();
    await expect(
      cancellableInference(async () => "ok", controller.signal)
    ).resolves.toBe("ok");
    await expect(
      cancellableInference(async () => {
        throw new Error("failed");
      }, controller.signal)
    ).rejects.toThrow("failed");
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});
