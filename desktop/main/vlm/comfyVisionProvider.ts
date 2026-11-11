import type { VlmModelStatus } from "../../shared/contracts";
import type { LibrarySettings } from "../librarySettings";

import { ComfyVlmClient } from "./comfyVlmClient";
import type { VisionGenerator } from "./visionGenerator";
import {
  QWEN3_VL_HERETIC_MODEL_SOURCE,
  QWEN3_VL_MODEL_SOURCE
} from "./vlmModelFiles";

export const generateComfyVision =
  (settings: LibrarySettings): VisionGenerator =>
  async (request) => {
    const [endpoint, model] = await Promise.all([
      settings.getComfyEndpoint(),
      settings.getVlmBackend()
    ]);
    const text = await new ComfyVlmClient(endpoint, model).generate(request);
    return { text, model };
  };

/** Probe models outside the generation queue so settings can check readiness. */
export const probeComfyVision = async (
  settings: LibrarySettings
): Promise<VlmModelStatus> => {
  try {
    const endpoint = await settings.getComfyEndpoint();
    const backend = await settings.getVlmBackend();
    const models = await new ComfyVlmClient(endpoint, backend).probeModels();
    const installMessage =
      backend === "qwen3-vl-4b-heretic-int8"
        ? `Download ${models.missing.join(" and ")} from ${QWEN3_VL_HERETIC_MODEL_SOURCE} into ComfyUI/models/text_encoders/`
        : `Download ${models.missing.join(" and ")} from ${QWEN3_VL_MODEL_SOURCE} into ComfyUI/models/LLM/GGUF/`;
    return {
      backend,
      ready: models.installed,
      missingModels: [...models.missing],
      message: models.installed ? null : installMessage
    };
  } catch (error) {
    // Missing node, or ComfyUI went away between the endpoint check and here.
    return {
      backend: await settings.getVlmBackend(),
      ready: false,
      missingModels: [],
      message:
        error instanceof Error ? error.message : "Qwen3-VL is unavailable"
    };
  }
};
