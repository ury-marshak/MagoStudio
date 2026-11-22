import { VideoEngine } from "@models/video/types";

import { usePostAdaptI2vPrompt } from "./data/usePostAdaptI2vPrompt";
import { TextModelRoute } from "./useTextModelRoute";
import { useUndoablePromptRewrite } from "./useUndoablePromptRewrite";

export const useAdaptableI2vPrompt = ({
  value,
  onChange,
  referenceAssetIds,
  engine,
  route,
  editorKey,
  editorTarget
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  referenceAssetIds: string[];
  engine: VideoEngine;
  route?: TextModelRoute;
  editorKey?: string;
  editorTarget?: object;
}) => {
  const { mutateAsync: adaptI2vPrompt, isPending: isAdaptingPrompt } =
    usePostAdaptI2vPrompt(route);

  const {
    rewritePrompt: adaptPrompt,
    undoRewritePrompt: undoAdaptPrompt,
    canUndoRewritePrompt: canUndoAdaptPrompt,
    isRewritingPrompt
  } = useUndoablePromptRewrite({
    value,
    onChange,
    editorKey,
    editorTarget,
    rewritePrompt: (prompt, signal) =>
      adaptI2vPrompt({
        requestBody: { prompt, reference_asset_ids: referenceAssetIds, engine },
        callerSignal: signal
      }),
    rewriteFailedMessageKey: "notifications.adapt_prompt_failed.description"
  });

  return {
    adaptPrompt,
    undoAdaptPrompt,
    isAdaptingPrompt:
      editorKey === undefined ? isAdaptingPrompt : isRewritingPrompt,
    canUndoAdaptPrompt
  };
};
