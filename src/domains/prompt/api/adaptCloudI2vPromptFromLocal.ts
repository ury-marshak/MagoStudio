import type { MirrorProgress } from "@domains/cloud/mirrorService";
import type { VideoEngine } from "@models/video/types";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { adaptWithStaleCloudReferencesReplaced } from "../utils/adaptWithStaleCloudReferencesReplaced";

import { markCloudAssetLinkStale } from "./markCloudAssetLinkStale";
import {
  mirrorAdaptPromptReferencesToCloud,
  resolveMirroredSourceVideoContext
} from "./mirrorAdaptPromptReferencesToCloud";
import { postAdaptI2vPrompt } from "./postAdaptI2vPrompt";

const scopeToPromptAttempt = (
  libraryWork: RendererLibraryWork,
  signal: AbortSignal
): RendererLibraryWork => {
  const check = () => signal.throwIfAborted();
  return {
    signal,
    check,
    ready: async () => {
      await libraryWork.ready();
      check();
    },
    // Keep already issued IPC in the original library’s acknowledgement drain.
    boundary: async (run) => {
      check();
      try {
        return await libraryWork.boundary(() => {
          check();
          return run();
        });
      } finally {
        check();
      }
    },
    cacheKey: async (key) => {
      check();
      const scopedKey = await libraryWork.cacheKey(key);
      check();
      return scopedKey;
    }
  };
};

const adapt = async (
  {
    prompt,
    sourceVideoTrackId,
    referenceImageAssetIds,
    cloudEngine,
    onProgress
  }: {
    prompt: string;
    sourceVideoTrackId?: string;
    referenceImageAssetIds: string[];
    cloudEngine: VideoEngine;
    onProgress?: MirrorProgress;
  },
  work: RendererLibraryWork
) => {
  const { signal } = work;
  // Readiness is not a write or an owned local-media operation; do not hold
  // renderer acknowledgement open for it.
  const hasExternalText = await runRendererLibraryRequest(work, () =>
    getLocalDesktopApi().vlm.hasExternalText()
  );
  signal.throwIfAborted();
  if (hasExternalText) throw new Error("External text configuration changed");

  let sourceVideoContext = sourceVideoTrackId
    ? await resolveMirroredSourceVideoContext(
        { sourceVideoTrackId, onProgress },
        work
      )
    : undefined;
  return adaptWithStaleCloudReferencesReplaced({
    signal,
    mirrorReferences: () =>
      mirrorAdaptPromptReferencesToCloud(
        {
          sourceVideoContext,
          referenceImageAssetIds,
          onProgress
        },
        work
      ),
    adapt: (cloudAssetIds) =>
      runRendererLibraryRequest(work, () =>
        postAdaptI2vPrompt(
          { prompt, reference_asset_ids: cloudAssetIds, engine: cloudEngine },
          signal
        )
      ),
    markReferenceStale: async (localAssetId) => {
      const isStaleSourceVideo =
        sourceVideoTrackId && localAssetId === sourceVideoContext?.localAssetId;
      await markCloudAssetLinkStale(
        isStaleSourceVideo && sourceVideoContext
          ? sourceVideoContext.cloudSourceVideoLinkLocalId
          : localAssetId,
        work
      );
      signal.throwIfAborted();
      if (isStaleSourceVideo)
        sourceVideoContext = await resolveMirroredSourceVideoContext(
          { sourceVideoTrackId, onProgress },
          work
        );
    }
  });
};

export const adaptCloudI2vPromptFromLocal = async (
  input: Parameters<typeof adapt>[0],
  work: RendererLibraryWork,
  callerSignal?: AbortSignal
) => {
  if (!callerSignal) return adapt(input, work);
  const signal = AbortSignal.any([work.signal, callerSignal]);
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    // Release the editor immediately. Main-owned uploads stay outside the
    // renderer drain; the library still tracks any IPC issued via boundary.
    return await Promise.race([
      cancelled,
      adapt(input, scopeToPromptAttempt(work, signal))
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
