import { LoadingIndicator } from "@components/LoadingIndicator";
import { useToast } from "@store/useToast";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import { MirrorProgress } from "./mirrorService";

type MirrorStep = Parameters<MirrorProgress>[0];

const STEP_MESSAGE_KEYS: Record<Exclude<MirrorStep, "done">, string> = {
  project: "notifications.cloud_sync_project.description",
  timeline: "notifications.cloud_sync_project.description",
  asset: "notifications.cloud_sync_asset.description",
  encoding: "notifications.cloud_sync_encoding.description",
  uploading: "notifications.cloud_sync_uploading.description",
  ingesting: "notifications.cloud_sync_ingesting.description"
};

/**
 * Shows a toast while a local asset is being mirrored to cloud Mago, so the
 * (sometimes multi-second) upload doesn't just look like the app hanging.
 */
export const useCloudSyncProgressToast = () => {
  const { t } = useTranslation();
  const { showToast, updateToast, hideToast } = useToast();
  const toastIdRef = useRef<string | null>(null);

  const dismissToast = (toast: { current: string | null }) => {
    if (toast.current) {
      hideToast(toast.current);
      toast.current = null;
    }
  };

  const showStep = (toast: { current: string | null }, step: MirrorStep) => {
    if (step === "done") {
      dismissToast(toast);
      return;
    }

    const message = (
      <div className="flex items-center gap-2">
        <LoadingIndicator className="shrink-0" />
        <span>{t(STEP_MESSAGE_KEYS[step])}</span>
      </div>
    );

    if (toast.current) {
      updateToast(toast.current, { message });
    } else {
      toast.current = showToast({
        message,
        showTimer: false,
        autoDismiss: false
      });
    }
  };

  const begin = (work: RendererLibraryWork) => {
    // Each attempt owns only its own toast (including late finally callbacks).
    const toast: { current: string | null } = { current: null };
    let finished = false;
    const dismiss = () => {
      finished = true;
      work.signal.removeEventListener("abort", dismiss);
      dismissToast(toast);
    };
    work.signal.addEventListener("abort", dismiss, { once: true });
    const onProgress: MirrorProgress = (step) => {
      if (!finished && !work.signal.aborted) showStep(toast, step);
    };
    return { dismiss, onProgress };
  };

  return {
    begin,
    onProgress: (step: MirrorStep) => showStep(toastIdRef, step),
    dismiss: () => dismissToast(toastIdRef)
  };
};
