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
  probeLegacyVision: () => Promise<VlmModelStatus>,
  readKey: (account: string) => Promise<string> = readExternalProviderKey
) => {
  const getGenerator = async (capability: ExternalModelCapability) => {
    const config = await settings.getForInference(capability);
    return config
      ? generateOpenAiCompatible(config, await readKey(config.keychainAccount))
      : null;
  };
  const generate =
    (capability: ExternalModelCapability): VisionGenerator =>
    async (request) => {
      request.signal?.throwIfAborted();
      const generator = (await getGenerator(capability)) ?? legacyVision;
      request.signal?.throwIfAborted();
      return generator(request);
    };
  return {
    getGenerator,
    generateVision: generate("vision"),
    generateEnhancement: generate("text"),
    probeVision: async (): Promise<VlmModelStatus> => {
      try {
        const config = await settings.getForInference("vision");
        if (!config) return await probeLegacyVision();
        await probeOpenAiCompatible(
          config,
          await readKey(config.keychainAccount),
          "vision"
        );
        return {
          backend: "external",
          ready: true,
          missingModels: [],
          message: null
        };
      } catch (error) {
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
