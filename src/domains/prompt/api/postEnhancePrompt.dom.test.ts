import { afterEach, describe, expect, it, vi } from "vitest";

import { postEnhancePrompt } from "./postEnhancePrompt";

const post = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { post }
}));

const installBridge = (external: boolean) => {
  const enhancePrompt = vi
    .fn()
    .mockResolvedValue({ enhanced_prompt: "Expanded" });
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { vlm: { enhancePrompt, hasExternalText: async () => external } }
  });
  return enhancePrompt;
};

afterEach(() => {
  Reflect.deleteProperty(window, "mago");
  vi.clearAllMocks();
});

describe("desktop image prompt enhancement", () => {
  it("sends the external route through the desktop bridge", async () => {
    const enhancePrompt = installBridge(true);

    await expect(
      postEnhancePrompt({ query: "A courier" }, "external")
    ).resolves.toEqual({ enhanced_prompt: "Expanded" });
    expect(enhancePrompt).toHaveBeenCalledExactlyOnceWith(
      {
        query: "A courier",
        version: undefined
      },
      undefined
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("blocks a stale cloud route when external text is configured", async () => {
    const enhancePrompt = installBridge(true);

    await expect(
      postEnhancePrompt({ query: "A courier" }, "cloud")
    ).rejects.toThrow("External text configuration changed");
    expect(enhancePrompt).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
