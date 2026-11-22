import { useToast } from "@store/useToast";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

export const useUndoablePromptRewrite = ({
  value,
  onChange,
  rewritePrompt,
  rewriteFailedMessageKey,
  work,
  editorKey,
  editorTarget
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  rewritePrompt: (prompt: string, signal?: AbortSignal) => Promise<string>;
  rewriteFailedMessageKey: string;
  work?: RendererLibraryWork;
  // Opt in for desktop adapters that stay mounted across editor/route changes.
  editorKey?: string;
  editorTarget?: object;
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const editor = useMemo(
    () => ({ editorKey, editorTarget }),
    [editorKey, editorTarget]
  );
  type Attempt = {
    work?: RendererLibraryWork;
    editor: typeof editor;
    value: string | undefined;
    controller?: AbortController;
  };
  const latestAttempt = useRef<Attempt | undefined>(undefined);
  const [pending, setPending] = useState<Attempt>();
  const [latestRewrite, setLatestRewrite] = useState<{
    work?: RendererLibraryWork;
    editor: typeof editor;
    before: string | undefined;
    after: string;
  }>();
  const currentOnChange = useRef(onChange);
  useLayoutEffect(() => {
    currentOnChange.current = onChange;
  }, [onChange]);
  useLayoutEffect(() => {
    if (editor.editorKey === undefined) return;
    return () => {
      const attempt = latestAttempt.current;
      latestAttempt.current = undefined;
      attempt?.controller?.abort();
    };
  }, [editor, value, work]);

  const active = !work?.signal.aborted;
  const rewrite = async () => {
    if (work?.signal.aborted) return;
    const attempt = {
      work,
      editor,
      value,
      controller:
        editor.editorKey === undefined ? undefined : new AbortController()
    };
    latestAttempt.current?.controller?.abort();
    latestAttempt.current = attempt;
    setPending(attempt);
    const canSettle = () =>
      latestAttempt.current === attempt && !work?.signal.aborted;

    try {
      const rewrittenPrompt = await rewritePrompt(
        value ?? "",
        attempt.controller?.signal
      );
      if (!canSettle()) return;
      const apply = attempt.controller ? currentOnChange.current : onChange;
      apply(rewrittenPrompt);
      setLatestRewrite({ work, editor, before: value, after: rewrittenPrompt });
    } catch (error) {
      if (!canSettle()) return;
      // Keep the original exception for diagnosing cloud/auth/upload failures.
      console.error("Prompt rewrite failed", error);
      showToast({ message: t(rewriteFailedMessageKey) });
    } finally {
      if (latestAttempt.current === attempt) {
        latestAttempt.current = undefined;
        setPending(undefined);
      }
    }
  };

  const canUndoRewrite =
    active &&
    latestRewrite !== undefined &&
    latestRewrite.work === work &&
    latestRewrite.editor === editor &&
    latestRewrite.after === value;

  return {
    rewritePrompt: rewrite,
    undoRewritePrompt: () => {
      if (canUndoRewrite && !work?.signal.aborted)
        onChange(latestRewrite.before);
    },
    canUndoRewritePrompt: canUndoRewrite,
    isRewritingPrompt:
      active &&
      pending !== undefined &&
      pending.work === work &&
      pending.editor === editor &&
      (!pending.controller ||
        (!pending.controller.signal.aborted && pending.value === value))
  };
};
