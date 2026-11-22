import { useCloudSyncProgressToast } from "@domains/cloud/useCloudSyncProgressToast";
import { VideoEngine } from "@models/video/types";
import { useToast } from "@store/useToast";
import { useTranslation } from "react-i18next";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { adaptCloudI2vPromptFromLocal } from "./api/adaptCloudI2vPromptFromLocal";
import { hasUnresolvedAdaptedReferences } from "./api/postAdaptI2vPrompt";
import { useInferenceCancellation } from "./useInferenceCancellation";
import { useUndoablePromptRewrite } from "./useUndoablePromptRewrite";

export const useCloudAdaptableI2vPromptFromLocal = ({
  value,
  onChange,
  sourceVideoTrackId,
  referenceImageAssetIds,
  cloudEngine,
  editorKey = "cloud",
  editorTarget
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  sourceVideoTrackId: string | undefined;
  referenceImageAssetIds: string[];
  cloudEngine: VideoEngine;
  editorKey?: string;
  editorTarget?: object;
}) => {
  const { work } = useRendererLibraryWork();
  const { begin } = useCloudSyncProgressToast();
  const { run } = useInferenceCancellation();
  const { t } = useTranslation();
  const { showToast } = useToast();

  const {
    rewritePrompt: adaptPrompt,
    undoRewritePrompt: undoAdaptPrompt,
    canUndoRewritePrompt: canUndoAdaptPrompt,
    isRewritingPrompt: isAdaptingPrompt
  } = useUndoablePromptRewrite({
    value,
    onChange,
    work,
    editorKey,
    editorTarget,
    rewritePrompt: (prompt, editorSignal) =>
      run(async (lifetimeSignal) => {
        const signal = editorSignal
          ? AbortSignal.any([lifetimeSignal, editorSignal])
          : lifetimeSignal;
        const progress = begin(work);
        signal.addEventListener("abort", progress.dismiss, { once: true });
        try {
          const response = await adaptCloudI2vPromptFromLocal(
            {
              prompt,
              sourceVideoTrackId,
              referenceImageAssetIds,
              cloudEngine,
              // Keep this attempt’s toast open across both mirrors and any retry.
              onProgress: (step) => {
                if (step !== "done" && !signal.aborted)
                  progress.onProgress(step);
              }
            },
            work,
            signal
          );
          work.check();
          signal.throwIfAborted();
          if (hasUnresolvedAdaptedReferences(response)) {
            showToast({
              message: t("notifications.adapt_prompt_partial.description")
            });
          }
          return response.adapted_prompt;
        } finally {
          signal.removeEventListener("abort", progress.dismiss);
          progress.dismiss();
        }
      }),
    rewriteFailedMessageKey: "notifications.adapt_prompt_failed.description"
  });

  return { adaptPrompt, undoAdaptPrompt, isAdaptingPrompt, canUndoAdaptPrompt };
};
