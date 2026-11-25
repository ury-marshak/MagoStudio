import type { VlmModelStatus } from "../../shared/contracts";
import type { VisionGenerator } from "../vlm/visionGenerator";

import {
  readExternalProviderKey,
  type createExternalProviderSettings,
  type ExternalModelCapability
} from "./externalProviderSettings";
import {
  generateOpenAiCompatible,
  probeOpenAiCompatible
} from "./openAiCompatible";
import { waitForInference } from "./sharedInference";

type Settings = ReturnType<typeof createExternalProviderSettings>;

/** Shared by foreground inference and automatic-caption readiness. Omitting a
 * capability in an external profile must never reach a legacy transport. */
export const createExternalInferenceRouting = (
  settings: Pick<Settings, "getForInference"> &
    Partial<Pick<Settings, "captureInferenceProfile">>,
  legacyVision: VisionGenerator,
  probeLegacyVision: (signal?: AbortSignal) => Promise<VlmModelStatus>,
  readKey: (
    account: string,
    signal?: AbortSignal
  ) => Promise<string> = readExternalProviderKey
) => {
  const capture = (caller?: AbortSignal) => {
    caller?.throwIfAborted();
    const profile = settings.captureInferenceProfile?.();
    return profile && caller
      ? AbortSignal.any([profile, caller])
      : (profile ?? caller);
  };
  const run = async <T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> => {
    signal?.throwIfAborted();
    const task = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    const result = await (signal ? waitForInference(task, signal) : task);
    signal?.throwIfAborted();
    return result;
  };
  const resolveGenerator = async (
    capability: ExternalModelCapability,
    signal?: AbortSignal
  ) => {
    const config = await settings.getForInference(capability);
    signal?.throwIfAborted();
    if (!config) return null;
    const key = await readKey(config.keychainAccount, signal);
    signal?.throwIfAborted();
    return generateOpenAiCompatible(config, key);
  };
  const generate =
    (capability: ExternalModelCapability): VisionGenerator =>
    async (request) => {
      const signal = capture(request.signal);
      return run(signal, async () => {
        const generator =
          (await resolveGenerator(capability, signal)) ?? legacyVision;
        signal?.throwIfAborted();
        return generator({ ...request, signal });
      });
    };
  return {
    getGenerator: async (
      capability: ExternalModelCapability,
      caller?: AbortSignal
    ) => {
      const origin = capture(caller);
      const generator = await run(origin, () =>
        resolveGenerator(capability, origin)
      );
      origin?.throwIfAborted();
      if (!generator) return null;
      // Script/shot adapters may hold this generator while preparing local inputs.
      const generate: VisionGenerator = async (request) => {
        const signal =
          origin && request.signal
            ? AbortSignal.any([origin, request.signal])
            : (origin ?? request.signal);
        return run(signal, () => generator({ ...request, signal }));
      };
      return generate;
    },
    generateVision: generate("vision"),
    generateEnhancement: generate("text"),
    probeVision: async (caller?: AbortSignal): Promise<VlmModelStatus> => {
      const signal = capture(caller);
      return run(signal, async () => {
        try {
          const config = await settings.getForInference("vision");
          signal?.throwIfAborted();
          if (!config) return await probeLegacyVision(signal);
          const key = await readKey(config.keychainAccount, signal);
          signal?.throwIfAborted();
          await probeOpenAiCompatible(config, key, "vision", signal);
          signal?.throwIfAborted();
          return {
            backend: "external",
            ready: true,
            missingModels: [],
            message: null
          };
        } catch (error) {
          signal?.throwIfAborted();
          return {
            backend: "external",
            ready: false,
            missingModels: [],
            message:
              error instanceof Error
                ? error.message
                : "External vision provider is unavailable"
          };
        }
      });
    }
  };
};
