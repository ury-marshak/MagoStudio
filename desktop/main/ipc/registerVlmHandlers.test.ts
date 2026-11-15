import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared/contracts";
import { LibraryWorkSession } from "../libraryWorkSession";
import type { LocalI2vPromptAdapter } from "../vlm/localI2vPromptAdapter";
import type { VlmService } from "../vlm/vlmService";

import { registerVlmHandlers } from "./registerVlmHandlers";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), trusted: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("./trustedSender", () => ({ requireTrustedSender: mocks.trusted }));

const setup = () => {
  const service = {
    libraryWork: new LibraryWorkSession(() => undefined),
    captionAsset: vi.fn(),
    autoPrompt: vi.fn(),
    enhancePrompt: vi.fn()
  };
  const adapter = { adapt: vi.fn() };
  const stop = registerVlmHandlers(
    service as unknown as VlmService,
    adapter as unknown as LocalI2vPromptAdapter,
    async () => true
  );
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false
  });
  const event = { sender };
  const handler = (channel: string) =>
    mocks.handle.mock.calls.find(([name]) => name === channel)![1];
  return { service, adapter, stop, sender, event, handler };
};

beforeEach(() => vi.clearAllMocks());

describe("VLM cancellation IPC", () => {
  it.each([
    [IPC_CHANNELS.vlmCaptionAsset, "asset", "captionAsset"],
    [
      IPC_CHANNELS.vlmAutoPrompt,
      {
        version: "img2img_mago",
        styleReferenceImage: "image",
        sourceVideoFrame: "frame"
      },
      "autoPrompt"
    ],
    [IPC_CHANNELS.vlmEnhancePrompt, { query: "courier" }, "enhancePrompt"],
    [IPC_CHANNELS.vlmAdaptI2vPrompt, { prompt: "courier" }, "adapt"]
  ] as const)(
    "cancels %s through its caller signal",
    async (channel, input, method) => {
      const test = setup();
      const generate =
        method === "adapt" ? test.adapter.adapt : test.service[method];
      generate.mockImplementation(async () => new Promise(() => {}));
      const result = test.handler(channel)(test.event, input, "request");
      const rejected = expect(result).rejects.toThrow();
      await Promise.resolve();
      expect(generate).toHaveBeenCalledTimes(1);
      const signal = generate.mock.calls[0]![1] as AbortSignal;
      expect(signal.aborted).toBe(false);
      test.handler(IPC_CHANNELS.vlmCancel)(test.event, "request");
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(mocks.trusted).toHaveBeenCalledTimes(2);
    }
  );

  it("checks trust before cancellation and validates inputs before starting work", async () => {
    const test = setup();
    await expect(
      test.handler(IPC_CHANNELS.vlmEnhancePrompt)(test.event, {}, "request")
    ).rejects.toThrow("query");
    expect(test.service.enhancePrompt).not.toHaveBeenCalled();
    mocks.trusted.mockImplementationOnce(() => {
      throw new Error("untrusted");
    });
    expect(() =>
      test.handler(IPC_CHANNELS.vlmCancel)(test.event, "request")
    ).toThrow("untrusted");
    test.stop();
    await expect(
      test.handler(IPC_CHANNELS.vlmEnhancePrompt)(
        test.event,
        { query: "test" },
        "new"
      )
    ).rejects.toThrow();
    expect(test.service.enhancePrompt).not.toHaveBeenCalled();
  });
});
