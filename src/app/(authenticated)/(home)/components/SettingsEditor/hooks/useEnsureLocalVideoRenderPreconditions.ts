import { videoRenderPrecondition } from "@domains/renders/utils/localRenderPrecondition";
import { VideoSettings } from "@models/video/types";
import { useToast } from "@store/useToast";

import { OPEN_CREDENTIALS_EVENT, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

const openCredentialsModal = (reason: "comfy" | "generate") => {
  window.dispatchEvent(
    new CustomEvent(OPEN_CREDENTIALS_EVENT, { detail: { reason } })
  );
};

export const useEnsureLocalVideoRenderPreconditions = () => {
  const { showToast } = useToast();

  const ensureLocalVideoRenderPreconditions = async (
    {
      model,
      renderSettingsValues
    }: {
      model: string;
      renderSettingsValues: VideoSettings;
    },
    work = rendererLibrary.capture()
  ): Promise<boolean> => {
    work.check();
    const precondition = videoRenderPrecondition(model, { isLocalApp });

    if (precondition === "comfy") {
      const comfy = await runRendererLibraryRequest(work, () =>
        window.mago.comfy.check()
      );
      work.check();
      if (!comfy.available) {
        openCredentialsModal("comfy");
        return false;
      }
      const modelStatus = await runRendererLibraryRequest(work, () =>
        window.mago.comfy.modelStatus({
          model,
          settings: renderSettingsValues
        })
      );
      work.check();
      if (!modelStatus.ready) {
        showToast({
          message:
            modelStatus.message ?? "The selected ComfyUI model is not ready",
          duration: 10
        });
        return false;
      }
      return true;
    }

    return true;
  };

  return { ensureLocalVideoRenderPreconditions };
};
