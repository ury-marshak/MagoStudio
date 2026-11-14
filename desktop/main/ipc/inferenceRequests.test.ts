import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { InferenceRequests } from "./inferenceRequests";

const sender = () =>
  Object.assign(new EventEmitter(), {
    isDestroyed: () => false
  }) as unknown as WebContents;
const never = () => new Promise<string>(() => {});

describe("InferenceRequests", () => {
  it("scopes cancellation and duplicate IDs to their renderer", async () => {
    const requests = new InferenceRequests();
    const a = sender();
    const b = sender();
    const taskA = vi.fn(never);
    let signalB!: AbortSignal;
    const first = requests.run(a, "same-id", taskA);
    const second = requests.run(b, "same-id", async (signal) => {
      signalB = signal;
      return never();
    });
    const rejected = expect(first).rejects.toThrow();
    const stopped = expect(second).rejects.toThrow();
    await Promise.resolve();
    await expect(requests.run(a, "same-id", never)).rejects.toThrow(
      "already active"
    );
    requests.cancel(a, "same-id");
    await rejected;
    expect(signalB.aborted).toBe(false);
    expect(a.listenerCount("destroyed")).toBe(0);
    requests.stop();
    await stopped;
    expect(signalB.aborted).toBe(true);
    expect(b.listenerCount("destroyed")).toBe(0);
  });

  it.each(["destroyed", "render-process-gone", "navigation"])(
    "aborts on renderer %s",
    async (event) => {
      const requests = new InferenceRequests();
      const owner = sender();
      let signal!: AbortSignal;
      const result = requests.run(owner, undefined, async (value) => {
        signal = value;
        return never();
      });
      const rejected = expect(result).rejects.toThrow();
      await Promise.resolve();
      if (event === "navigation") {
        owner.emit("did-start-navigation", {}, "https://editor/", false, false);
        expect(signal.aborted).toBe(false);
        owner.emit("did-start-navigation", {}, "https://editor/", false, true);
      } else owner.emit(event);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(owner.listenerCount("did-start-navigation")).toBe(0);
    }
  );

  it("rejects invalid IDs before starting work, and cleans up after failure", async () => {
    const requests = new InferenceRequests();
    const owner = sender();
    const task = vi.fn(never);
    await expect(requests.run(owner, {}, task)).rejects.toThrow("Invalid");
    expect(task).not.toHaveBeenCalled();
    await expect(
      requests.run(owner, "fail", async () => {
        throw new Error("provider failed");
      })
    ).rejects.toThrow("provider failed");
    expect(owner.listenerCount("destroyed")).toBe(0);
    await expect(requests.run(owner, "fail", async () => "ok")).resolves.toBe(
      "ok"
    );
  });
});
