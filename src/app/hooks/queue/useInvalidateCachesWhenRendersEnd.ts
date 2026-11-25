import {
  findRendersThatJustEnded,
  RenderSnapshot,
  toRenderSnapshots
} from "@domains/queue/utils/findRendersThatJustEnded";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { invalidateCachesForEndedRenders } from "./invalidateCachesForEndedRenders";
import { useQueue } from "./useQueue";

export const useInvalidateCachesWhenRendersEnd = () => {
  const queryClient = useQueryClient();
  const { data: queueItems } = useQueue();
  const { work } = useRendererLibraryWork();
  const previous = useRef<{
    signal: AbortSignal;
    renders: Map<string, RenderSnapshot>;
  }>(undefined);

  // oxlint-disable-next-line custom-react/no-use-effect -- reacts to each queue poll, whose arrival React only exposes as changed data
  useEffect(() => {
    if (!queueItems || work.signal.aborted) return;
    const baseline = previous.current;
    const currentRenders = toRenderSnapshots(queueItems);
    previous.current = { signal: work.signal, renders: currentRenders };
    if (baseline?.signal !== work.signal) return;
    const endedRenders = findRendersThatJustEnded({
      previousRenders: baseline.renders,
      currentRenders
    });
    if (endedRenders.length)
      invalidateCachesForEndedRenders({ queryClient, endedRenders });
  }, [queueItems, queryClient, work]);
};
