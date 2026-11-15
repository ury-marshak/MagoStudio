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

/** Shared by foreground inference and automatic-caption readiness. Omitting a
 * capability in an external profile must never reach a legacy transport. */
export const createExternalInferenceRouting = (
  settings: Pick<
    ReturnType<typeof createExternalProviderSettings>,
    "getForInference"
  >,
  legacyVision: VisionGenerator,
  probeLegacyVision: (signal?: AbortSignal) => Promise<VlmModelStatus>,
  readKey: (account: string) => Promise<string> = readExternalProviderKey
) => {
  const getGenerator = async (
    capability: ExternalModelCapability,
    signal?: AbortSignal
  ) => {
    signal?.throwIfAborted();
    const config = await settings.getForInference(capability);
    signal?.throwIfAborted();
    if (!config) return null;
    const key = await readKey(config.keychainAccount);
    signal?.throwIfAborted();
    return generateOpenAiCompatible(config, key);
  };
  const generate =
    (capability: ExternalModelCapability): VisionGenerator =>
    async (request) => {
      request.signal?.throwIfAborted();
      const generator =
        (await getGenerator(capability, request.signal)) ?? legacyVision;
      request.signal?.throwIfAborted();
      return generator(request);
    };
  return {
    getGenerator,
    generateVision: generate("vision"),
    generateEnhancement: generate("text"),
    probeVision: async (signal?: AbortSignal): Promise<VlmModelStatus> => {
      signal?.throwIfAborted();
      try {
        const config = await settings.getForInference("vision");
        signal?.throwIfAborted();
        if (!config) return await probeLegacyVision(signal);
        const key = await readKey(config.keychainAccount);
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
    }
  };
};
