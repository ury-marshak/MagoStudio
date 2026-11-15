import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComfyClient } from "../comfy/ComfyClient";
import type { ProjectRepository } from "../database/projectRepository";
import type { LibrarySettings } from "../librarySettings";
import { createExternalInferenceRouting } from "../providers/externalInferenceRouting";
import type { ExternalModelConfig } from "../providers/externalProviderSettings";
import { probeOpenAiCompatible } from "../providers/openAiCompatible";

import { generateComfyVision, probeComfyVision } from "./comfyVisionProvider";
import { ComfyVlmClient } from "./comfyVlmClient";
import { VlmService } from "./vlmService";

vi.mock("electron", () => ({ nativeImage: {} }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
const config: ExternalModelConfig = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "fixture",
  keychainAccount: "fixture"
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" }
  });
const catalog = () =>
  json({
    data: [{ id: "fixture", architecture: { input_modalities: ["image"] } }]
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("VLM readiness continuation ownership", () => {
  it.each(["metadata", "credential"])(
    "does not dispatch a background probe after delayed %s resolution",
    async (stage) => {
      const metadata = deferred<ExternalModelConfig | null>();
      const credential = deferred<string>();
      const getForInference = vi.fn(() =>
        stage === "metadata" ? metadata.promise : Promise.resolve(config)
      );
      const readKey = vi.fn(() => credential.promise);
      const legacy = vi.fn();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const routing = createExternalInferenceRouting(
        { getForInference },
        legacy,
        legacy,
        readKey
      );
      const service = new VlmService(
        {} as ProjectRepository,
        routing.generateVision,
        routing.probeVision
      );
      service.describeAssetLater("copied-id");
      if (stage === "credential")
        await vi.waitFor(() => expect(readKey).toHaveBeenCalledTimes(1));
      await service.suspend();
      service.reset();
      metadata.resolve(config);
      credential.resolve("synthetic-not-a-real-key");
      await flush();
      expect(fetch).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
      if (stage === "metadata") expect(readKey).not.toHaveBeenCalled();
      service.stop();
    }
  );

  it("does not start the legacy probe after a stale omitted metadata result", async () => {
    const metadata = deferred<null>();
    const legacy = vi.fn();
    const routing = createExternalInferenceRouting(
      { getForInference: () => metadata.promise },
      legacy,
      legacy,
      vi.fn()
    );
    const controller = new AbortController();
    const result = routing.probeVision(controller.signal);
    const rejected = expect(result).rejects.toThrow();
    controller.abort();
    metadata.resolve(null);
    await rejected;
    expect(legacy).not.toHaveBeenCalled();
  });

  it("propagates abort to the catalog and never follows a late catalog with a key check", async () => {
    const response = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const result = probeOpenAiCompatible(
      config,
      "synthetic",
      "vision",
      controller.signal
    );
    const rejected = expect(result).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
    controller.abort();
    expect(signal.aborted).toBe(true);
    response.resolve(catalog());
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps active external readiness behavior including OpenRouter key validation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(json({ data: {} }));
    vi.stubGlobal("fetch", fetch);
    const routing = createExternalInferenceRouting(
      { getForInference: async () => config },
      vi.fn(),
      vi.fn(),
      async () => "synthetic"
    );
    await expect(
      routing.probeVision(new AbortController().signal)
    ).resolves.toMatchObject({ ready: true, backend: "external" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/models",
      "https://openrouter.ai/api/v1/key"
    ]);
  });

  it.each(["probe", "generate"])(
    "stops legacy %s after a delayed endpoint without reading a new library backend",
    async (kind) => {
      const endpoint = deferred<string>();
      const backend = vi.fn(async () => "qwen3-vl-2b-gguf");
      const settings = {
        getComfyEndpoint: () => endpoint.promise,
        getVlmBackend: backend
      } as unknown as LibrarySettings;
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      const result =
        kind === "probe"
          ? probeComfyVision(settings, controller.signal)
          : generateComfyVision(settings)({
              systemPrompt: "system",
              userPrompt: "prompt",
              maxTokens: 100,
              temperature: 0.1,
              signal: controller.signal
            });
      const rejected = expect(result).rejects.toThrow();
      controller.abort();
      endpoint.resolve("http://127.0.0.1:8188");
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
      if (kind === "probe") expect(backend).not.toHaveBeenCalled();
    }
  );

  it("does not turn cancellation into an unavailable-model status or another settings read", async () => {
    const endpoint = deferred<string>();
    const controller = new AbortController();
    const backend = vi.fn();
    const settings = {
      getComfyEndpoint: () => endpoint.promise,
      getVlmBackend: backend
    } as unknown as LibrarySettings;
    const result = probeComfyVision(settings, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    controller.abort();
    endpoint.resolve("http://127.0.0.1:8188");
    await rejected;
    expect(backend).not.toHaveBeenCalled();
  });
});

describe("legacy VLM local teardown without provider cancellation", () => {
  const client = () => {
    const comfy = {
      endpoint: "http://127.0.0.1:8188",
      getJson: vi.fn(),
      uploadBytes: vi.fn(),
      submitGraph: vi.fn(),
      waitForPrompt: vi.fn(),
      removeFromQueueIfPending: vi.fn()
    };
    const vlm = new ComfyVlmClient(
      comfy.endpoint,
      "qwen3-vl-4b-heretic-int8",
      comfy as unknown as ComfyClient
    );
    const controller = new AbortController();
    const request = {
      systemPrompt: "system",
      userPrompt: "prompt",
      signal: controller.signal,
      images: [Buffer.from("image")]
    };
    vi.spyOn(vlm, "probeModels").mockResolvedValue({
      installed: true,
      gguf: null,
      mmproj: null,
      safetensors: "fixture.safetensors",
      missing: []
    });
    return { comfy, vlm, controller, request };
  };

  it("does not submit after an abort-ignoring upload resolves", async () => {
    const test = client();
    const gate = deferred<string>();
    test.comfy.uploadBytes.mockReturnValue(gate.promise);
    const result = test.vlm.generate(test.request);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.comfy.uploadBytes).toHaveBeenCalledTimes(1)
    );
    test.controller.abort();
    gate.resolve("uploaded.png");
    await rejected;
    expect(test.comfy.submitGraph).not.toHaveBeenCalled();
    expect(test.comfy.removeFromQueueIfPending).not.toHaveBeenCalled();
  });

  it("does not poll or cancel after a late submission acknowledgement", async () => {
    const test = client();
    const gate = deferred<string>();
    test.comfy.uploadBytes.mockResolvedValue("uploaded.png");
    test.comfy.submitGraph.mockReturnValue(gate.promise);
    const result = test.vlm.generate(test.request);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.comfy.submitGraph).toHaveBeenCalledTimes(1)
    );
    test.controller.abort();
    gate.resolve("accepted-id");
    await rejected;
    expect(test.comfy.waitForPrompt).not.toHaveBeenCalled();
    expect(test.comfy.removeFromQueueIfPending).not.toHaveBeenCalled();
    expect(test.comfy.submitGraph).toHaveBeenCalledTimes(1);
  });

  it("abandons active polling without invoking provider cancellation", async () => {
    const test = client();
    const gate = deferred<{ kind: "cancelled" }>();
    test.comfy.uploadBytes.mockResolvedValue("uploaded.png");
    test.comfy.submitGraph.mockResolvedValue("accepted-id");
    test.comfy.waitForPrompt.mockReturnValue(gate.promise);
    const result = test.vlm.generate(test.request);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.comfy.waitForPrompt).toHaveBeenCalledTimes(1)
    );
    const options = test.comfy.waitForPrompt.mock.calls[0]![1];
    expect(options.isCancelled()).toBe(false);
    test.controller.abort();
    expect(options.isCancelled()).toBe(true);
    gate.resolve({ kind: "cancelled" });
    await rejected;
    expect(test.comfy.removeFromQueueIfPending).not.toHaveBeenCalled();
  });

  it("stops multi-request native model discovery after a late loader response", async () => {
    const test = client();
    vi.mocked(test.vlm.probeModels).mockRestore();
    const gate = deferred<Record<string, unknown>>();
    test.comfy.getJson.mockReturnValue(gate.promise);
    const result = test.vlm.probeModels(test.controller.signal);
    const rejected = expect(result).rejects.toThrow();
    test.controller.abort();
    gate.resolve({ CLIPLoader: {} });
    await rejected;
    expect(test.comfy.getJson).toHaveBeenCalledTimes(1);
    expect(test.comfy.removeFromQueueIfPending).not.toHaveBeenCalled();
  });
});
