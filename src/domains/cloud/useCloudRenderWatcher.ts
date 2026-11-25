"use client";

import { useQueryClient } from "@tanstack/react-query";
/* oxlint-disable custom-react/no-use-effect -- an interval is external state */
import { useEffect } from "react";

import { backendApiClient } from "@/lib/backend-api-client";
import { isCloudAccountActive } from "@/platform/cloudAccount";
import { isLocalApp } from "@/platform/localDesktop";
import { runRendererLibraryRequest } from "@/platform/rendererLibraryWork";
import { isCloudRenderAvailable } from "@/platform/renderTarget";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { pollCloudImageRenders } from "./pollCloudImageRenders";
import { pollCloudRenders } from "./pollCloudRenders";
import { rendererCloudBackgroundWork } from "./rendererCloudBackgroundWork";

/**
 * Keeps cloud renders moving while the app is open.
 *
 * Runs once on mount so a render that outlived its window is picked back up, then
 * on an interval. Only mounts work when the desktop app can actually reach cloud
 * Mago: offline, this does nothing and makes no request.
 *
 * A finished or failed job stops being "active" the moment this poll completes
 * it, so it never passes through `useQueue`'s FINISHED-count comparison the way
 * a local render does -- it just disappears from the active list. Without an
 * invalidation here, the timeline and preview only pick up the result after a
 * manual reload.
 */

const POLL_INTERVAL_MS = 5000;

export const useCloudRenderWatcher = (): void => {
  const queryClient = useQueryClient();
  const { work: origin } = useRendererLibraryWork();

  useEffect(() => {
    if (!isLocalApp || !isCloudRenderAvailable() || !isCloudAccountActive())
      return;
    const work = rendererCloudBackgroundWork(origin);
    if (work.signal.aborted) return;

    // Each interval retains its origin; reset creates a separate interval/pass.
    const cloudApi = {
      post: async <T>(url: string, body?: unknown): Promise<T> => {
        return runRendererLibraryRequest(
          work,
          async (signal) =>
            (await backendApiClient.post<T>(url, body ?? {}, { signal })).data
        );
      },
      get: async <T>(url: string): Promise<T> => {
        return runRendererLibraryRequest(
          work,
          async (signal) =>
            (await backendApiClient.get<T>(url, { signal })).data
        );
      }
    };
    let cancelled = false;
    let running = false;
    const invalidate = (queryKey: readonly unknown[]) => {
      if (!cancelled && !work.signal.aborted)
        return queryClient.invalidateQueries({ queryKey });
    };

    const tick = async () => {
      // Never overlap: a slow download must not start a second pass.
      if (
        running ||
        cancelled ||
        work.signal.aborted ||
        !isCloudRenderAvailable() ||
        !isCloudAccountActive()
      )
        return;
      running = true;
      try {
        // Separate endpoints, separate pollers: img2img has no project-wide
        // queue the way video does (see pollCloudImageRenders.ts).
        const [videoOutcome, imageOutcome] = await Promise.all([
          pollCloudRenders(cloudApi, work),
          pollCloudImageRenders(cloudApi, work)
        ]);
        work.check();
        if (cancelled) return;
        const finished = videoOutcome.finished + imageOutcome.finished;
        const failed = videoOutcome.failed + imageOutcome.failed;
        if (videoOutcome.checked + imageOutcome.checked > 0) {
          void invalidate(queryKeys.queue.all);
        }
        if (finished > 0 || failed > 0) {
          void invalidate(queryKeys.balance.all);
          void invalidate(queryKeys.project.all);
          void invalidate(queryKeys.timelineList.all);
          void invalidate(queryKeys.videoAsset.all);
          void invalidate(queryKeys.assetLibraryItems.all);
          void invalidate(["filmstrip-generate"]);
        }
      } catch {
        // A failed pass is not worth surfacing; the next tick tries again.
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    const stop = () => {
      cancelled = true;
      clearInterval(timer);
      work.signal.removeEventListener("abort", stop);
    };
    work.signal.addEventListener("abort", stop, { once: true });
    void tick();
    return stop;
  }, [queryClient, origin]);
};
