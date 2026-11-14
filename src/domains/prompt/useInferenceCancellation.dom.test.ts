import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useInferenceCancellation } from "./useInferenceCancellation";

describe("useInferenceCancellation", () => {
  it("aborts all in-flight mutations on unmount and suppresses late results", async () => {
    const { result, unmount } = renderHook(() => useInferenceCancellation());
    let signal!: AbortSignal;
    let finish!: (value: string) => void;
    const pending = result.current.run((caller) => {
      signal = caller;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    unmount();
    expect(signal.aborted).toBe(true);
    finish("late");
    await expect(pending).rejects.toThrow();
  });

  it("allows a new action after explicit cancellation", async () => {
    const { result } = renderHook(() => useInferenceCancellation());
    let signal!: AbortSignal;
    let finish!: (value: string) => void;
    const pending = result.current.run((caller) => {
      signal = caller;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    act(() => result.current.cancel());
    expect(signal.aborted).toBe(true);
    finish("late");
    await expect(pending).rejects.toThrow();
    await expect(result.current.run(async () => "new")).resolves.toBe("new");
  });
});
