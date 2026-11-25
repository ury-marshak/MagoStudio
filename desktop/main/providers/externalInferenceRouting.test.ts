import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ nativeImage: {} }));

import type { ProjectRepository } from "../database/projectRepository";
import type { VisionRequest } from "../vlm/visionGenerator";
import { VlmService } from "../vlm/vlmService";

import { createExternalInferenceRouting } from "./externalInferenceRouting";
import {
  createExternalProviderSettings,
  resolveProviderStartupMode
} from "./externalProviderSettings";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let directory: string;
const config = {
  baseUrl: "https://inference.invalid/api/v1",
  model: "fixture-model",
  keychainAccount: "nonexistent-audit-account"
};
const request: VisionRequest = {
  systemPrompt: "Fixture only",
  userPrompt: "Do not contact a real provider",
  maxTokens: 16,
  temperature: 0.1
};
const legacyVision = vi.fn(async () => ({ text: "legacy", model: "legacy" }));
const probeLegacy = vi.fn(async () => ({
  backend: "qwen3-vl-2b-gguf" as const,
  ready: true,
  missingModels: [],
  message: null
}));
// Injected fixture, never the OS Keychain implementation.
const readKey = vi.fn(async (_account: string) => "fixture-not-a-credential");
const transport = vi.fn<typeof fetch>();
const writeProfile = (profile: unknown) =>
  writeFile(
    path.join(directory, "external-providers.json"),
    JSON.stringify(profile)
  );
const settings = () => createExternalProviderSettings(() => directory);
const routing = () =>
  createExternalInferenceRouting(
    settings(),
    legacyVision,
    probeLegacy,
    readKey
  );

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mago-inference-audit-"));
  vi.clearAllMocks();
  transport.mockReset().mockRejectedValue(new Error("Unexpected transport"));
  readKey.mockReset().mockResolvedValue("fixture-not-a-credential");
  vi.stubGlobal("fetch", transport);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

const profiles = [
  {
    name: "fal-only",
    value: { fal: { keychainAccount: "nonexistent-audit-account" } },
    missing: ["text", "vision"]
  },
  { name: "text-only", value: { text: config }, missing: ["vision"] },
  { name: "vision-only", value: { vision: config }, missing: ["text"] }
] as const;

describe("external inference omission boundary", () => {
  it.each(profiles)(
    "opens $name account-free without probing or credentials",
    async ({ value }) => {
      await writeProfile(value);
      await expect(resolveProviderStartupMode(null, settings())).resolves.toBe(
        "offline"
      );
      expect(transport).not.toHaveBeenCalled();
      expect(readKey).not.toHaveBeenCalled();
      expect(probeLegacy).not.toHaveBeenCalled();
      await expect(settings().assertLegacyInferenceAvailable()).rejects.toThrow(
        "unavailable while external providers"
      );
    }
  );

  it.each(profiles)(
    "refuses omitted capabilities in $name before any legacy or external transport",
    async ({ value, missing }) => {
      await writeProfile(value);
      const route = routing();
      for (const capability of missing) {
        await expect(route.getGenerator(capability)).rejects.toThrow(
          `external ${capability} provider`
        );
        await expect(
          capability === "vision"
            ? route.generateVision(request)
            : route.generateEnhancement(request)
        ).rejects.toThrow(`external ${capability} provider`);
      }
      if (missing.some((capability) => capability === "vision"))
        await expect(route.probeVision()).resolves.toMatchObject({
          backend: "external",
          ready: false,
          message: expect.stringContaining("external vision provider")
        });
      expect(transport).not.toHaveBeenCalled();
      expect(readKey).not.toHaveBeenCalled();
      expect(legacyVision).not.toHaveBeenCalled();
      expect(probeLegacy).not.toHaveBeenCalled();
    }
  );

  it.each(
    profiles.filter(({ missing }) =>
      missing.some((entry) => entry === "vision")
    )
  )(
    "skips automatic captions without a Comfy probe in $name",
    async ({ value }) => {
      await writeProfile(value);
      const route = routing();
      const status = vi.fn(route.probeVision);
      const repository = { getAsset: vi.fn() };
      const vlm = new VlmService(
        repository as unknown as ProjectRepository,
        route.generateVision,
        status
      );
      vlm.describeAssetLater("copied-asset-id");
      await vi.waitFor(() =>
        expect(status).toHaveResolvedWith(
          expect.objectContaining({ ready: false })
        )
      );
      expect(repository.getAsset).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(readKey).not.toHaveBeenCalled();
      expect(probeLegacy).not.toHaveBeenCalled();
      expect(legacyVision).not.toHaveBeenCalled();
      vlm.stop();
    }
  );

  it.each([
    { fal: null },
    { vision: {} },
    { text: { ...config, baseUrl: "http://localhost:8188" } },
    { unexpected: true }
  ])("fails closed for damaged metadata %j", async (value) => {
    await writeProfile(value);
    const route = routing();
    await expect(route.getGenerator("text")).rejects.toThrow();
    await expect(route.getGenerator("vision")).rejects.toThrow();
    await expect(settings().assertLegacyInferenceAvailable()).rejects.toThrow();
    await expect(route.probeVision()).resolves.toMatchObject({ ready: false });
    expect(transport).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(legacyVision).not.toHaveBeenCalled();
    expect(probeLegacy).not.toHaveBeenCalled();
  });

  it("keeps capabilities independent of unrelated malformed entries", async () => {
    await writeProfile({ text: config, fal: null });
    transport.mockResolvedValue(
      Response.json({
        model: config.model,
        choices: [
          { finish_reason: "stop", message: { content: "fixture completion" } }
        ]
      })
    );
    await expect(routing().generateEnhancement(request)).resolves.toMatchObject(
      { text: "fixture completion" }
    );
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      `${config.baseUrl}/chat/completions`,
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
    expect(legacyVision).not.toHaveBeenCalled();
  });

  it.each(["key", "http", "malformed"])(
    "does not fall back on configured-provider %s failure",
    async (failure) => {
      await writeProfile({ text: config, vision: config });
      if (failure === "key")
        readKey.mockRejectedValue(new Error("Missing fixture credential"));
      else
        transport.mockImplementation(async () =>
          failure === "http"
            ? new Response(null, { status: 401 })
            : Response.json({ invalid: true })
        );
      const route = routing();
      await expect(route.generateVision(request)).rejects.toThrow();
      await expect(route.generateEnhancement(request)).rejects.toThrow();
      await expect(route.probeVision()).resolves.toMatchObject({
        ready: false
      });
      expect(legacyVision).not.toHaveBeenCalled();
      expect(probeLegacy).not.toHaveBeenCalled();
      if (failure === "key") expect(transport).not.toHaveBeenCalled();
      else
        expect(
          transport.mock.calls.every(
            ([url]) =>
              typeof url === "string" && url.startsWith(config.baseUrl + "/")
          )
        ).toBe(true);
    }
  );

  it("preserves legacy behavior only when no external entries exist", async () => {
    const route = routing();
    await expect(route.getGenerator("text")).resolves.toBeNull();
    await expect(route.generateVision(request)).resolves.toMatchObject({
      model: "legacy"
    });
    await expect(route.probeVision()).resolves.toMatchObject({ ready: true });
    await expect(
      settings().assertLegacyInferenceAvailable()
    ).resolves.toBeUndefined();
    await writeProfile({});
    await expect(route.getGenerator("vision")).resolves.toBeNull();
    expect(readKey).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not access metadata or credentials after caller cancellation", async () => {
    const getForInference = vi.fn();
    const route = createExternalInferenceRouting(
      { getForInference },
      legacyVision,
      probeLegacy,
      readKey
    );
    await expect(
      route.generateVision({ ...request, signal: AbortSignal.abort() })
    ).rejects.toThrow();
    expect(getForInference).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
  });
});

describe("external inference profile lifetime", () => {
  it("does not resume an old credential lookup after A → B → A", async () => {
    const store = settings();
    const route = createExternalInferenceRouting(
      store,
      legacyVision,
      probeLegacy,
      readKey
    );
    await store.save("text", config);
    const keyStarted = deferred<void>();
    const key = deferred<string>();
    readKey.mockImplementationOnce(() => {
      keyStarted.resolve();
      return key.promise;
    });
    const rejected = expect(
      route.generateEnhancement(request)
    ).rejects.toMatchObject({
      name: "AbortError"
    });
    await keyStarted.promise;
    await store.save("text", { ...config, model: "new-model" });
    await store.save("text", config);
    await rejected;
    key.resolve("fixture-not-a-credential");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
    expect(legacyVision).not.toHaveBeenCalled();
  });

  it.each(["text", "vision", "readiness"] as const)(
    "aborts issued %s, drops its late response, and does not retry",
    async (kind) => {
      const capability = kind === "text" ? "text" : "vision";
      const store = settings();
      const route = createExternalInferenceRouting(
        store,
        legacyVision,
        probeLegacy,
        readKey
      );
      await store.save(capability, config);
      const requestStarted = deferred<AbortSignal | null | undefined>();
      const response = deferred<Response>();
      transport.mockImplementationOnce((_url, init) => {
        requestStarted.resolve(init?.signal);
        return response.promise;
      });
      const result =
        kind === "readiness"
          ? route.probeVision()
          : kind === "text"
            ? route.generateEnhancement(request)
            : route.generateVision(request);
      const rejected = expect(result).rejects.toMatchObject({
        name: "AbortError"
      });
      const signal = await requestStarted.promise;
      await store.save(capability, { ...config, model: "next-model" });
      expect(signal?.aborted).toBe(true);
      await rejected;

      const cancel = vi.fn();
      response.resolve(new Response(new ReadableStream({ cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect(transport).toHaveBeenCalledTimes(1);
      expect(legacyVision).not.toHaveBeenCalled();
      expect(probeLegacy).not.toHaveBeenCalled();
    }
  );

  it("retires a held text generator on last-provider removal and allows only new work to use legacy", async () => {
    const store = settings();
    const route = createExternalInferenceRouting(
      store,
      legacyVision,
      probeLegacy,
      readKey
    );
    await store.save("text", config);
    const generate = await route.getGenerator("text");
    expect(generate).not.toBeNull();

    const removal = store.save("text", null);
    await expect(route.generateEnhancement(request)).rejects.toMatchObject({
      name: "AbortError"
    });
    await removal;
    await expect(generate!(request)).rejects.toMatchObject({
      name: "AbortError"
    });
    await expect(route.getGenerator("text")).resolves.toBeNull();
    await expect(route.generateEnhancement(request)).resolves.toMatchObject({
      model: "legacy"
    });
    expect(transport).not.toHaveBeenCalled();
    expect(legacyVision).toHaveBeenCalledTimes(1);
  });
});
