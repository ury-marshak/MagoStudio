import type { VlmModelStatus } from "../../shared/contracts";
import { createProfileComfyClient } from "../comfy/ComfyClient";
import type { LibrarySettings } from "../librarySettings";

import { ComfyVlmClient } from "./comfyVlmClient";
import type { VisionGenerator } from "./visionGenerator";
import {
  QWEN3_VL_HERETIC_MODEL_SOURCE,
  QWEN3_VL_MODEL_SOURCE
} from "./vlmModelFiles";

export const generateComfyVision =
  (
    settings: LibrarySettings,
    captureProfile?: () => AbortSignal
  ): VisionGenerator =>
  async (request) => {
    const profile = captureProfile?.();
    request.signal?.throwIfAborted();
    const [endpoint, model] = await Promise.all([
      settings.getComfyEndpoint(),
      settings.getVlmBackend()
    ]);
    request.signal?.throwIfAborted();
    profile?.throwIfAborted();
    const comfy = profile
      ? createProfileComfyClient(endpoint, profile, request.signal)
      : undefined;
    const text = await new ComfyVlmClient(endpoint, model, comfy).generate(
      request
    );
    profile?.throwIfAborted();
    request.signal?.throwIfAborted();
    return { text, model };
  };

/** Probe models outside the generation queue so settings can check readiness. */
export const probeComfyVision = async (
  settings: LibrarySettings,
  signal?: AbortSignal,
  profile?: AbortSignal
): Promise<VlmModelStatus> => {
  signal?.throwIfAborted();
  try {
    const endpoint = await settings.getComfyEndpoint();
    signal?.throwIfAborted();
    const backend = await settings.getVlmBackend();
    signal?.throwIfAborted();
    profile?.throwIfAborted();
    const comfy = profile
      ? createProfileComfyClient(endpoint, profile, signal)
      : undefined;
    const models = await new ComfyVlmClient(
      endpoint,
      backend,
      comfy
    ).probeModels(signal);
    profile?.throwIfAborted();
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    profile?.throwIfAborted();
    // Missing node, or ComfyUI went away between the endpoint check and here.
    const backend = await settings.getVlmBackend();
    signal?.throwIfAborted();
    profile?.throwIfAborted();
    return {
      backend,
      ready: false,
      missingModels: [],
      message:
        error instanceof Error ? error.message : "Qwen3-VL is unavailable"
    };
  }
};
