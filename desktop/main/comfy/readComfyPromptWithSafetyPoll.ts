import { addAbortListener } from "node:events";

import type { ComfyProgressMonitor } from "./ComfyProgressMonitor";
import { COMFY_SAFETY_POLL_INTERVAL_MS } from "./comfySafetyPoll";

// Detach waits on providers that ignore abort. The caller still owns cleanup
// of anything the issued operation returns after retirement.
export const awaitComfyAbort = async <T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  if (!signal) return operation;
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        subscription = addAbortListener(signal, () => reject(signal.reason));
      })
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    subscription?.[Symbol.dispose]();
  }
};

type ComfyPromptOutcome =
  | { state: "queued" | "running" }
  | { state: "finished" }
  | { state: "error"; message: string };

export const readComfyPromptWithSafetyPoll = async <
  TResult extends ComfyPromptOutcome
>({
  monitor,
  promptId,
  lastStatusCheckAt,
  readOverHttp,
  signal
}: {
  monitor: Pick<
    ComfyProgressMonitor,
    "livePrompt" | "resetConnection" | "forget"
  >;
  promptId: string;
  lastStatusCheckAt: number;
  readOverHttp: () => Promise<TResult>;
  signal?: AbortSignal;
}): Promise<{
  result: TResult | { state: "queued" | "running" };
  statusCheckedAt: number | null;
}> => {
  signal?.throwIfAborted();
  const livePrompt = monitor.livePrompt(promptId);
  const isStillRunningOnLiveSocket =
    livePrompt !== null && livePrompt.phase !== "settled";
  const isSafetyPollDue =
    Date.now() - lastStatusCheckAt >= COMFY_SAFETY_POLL_INTERVAL_MS;
  if (isStillRunningOnLiveSocket && !isSafetyPollDue)
    return {
      result: { state: livePrompt.phase === "running" ? "running" : "queued" },
      statusCheckedAt: null
    };
  const statusCheckedAt = Date.now();
  const result = await awaitComfyAbort(readOverHttp(), signal);
  signal?.throwIfAborted();
  const isPromptOver = result.state === "finished" || result.state === "error";
  if (isPromptOver) {
    const didSocketMissTheEnd = isStillRunningOnLiveSocket;
    if (didSocketMissTheEnd) monitor.resetConnection();
    monitor.forget(promptId);
  }
  return { result, statusCheckedAt };
};
