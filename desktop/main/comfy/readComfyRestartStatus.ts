import type {
  ComfyRestartMethod,
  ComfyRestartStatus
} from "../../shared/contracts";

import { ComfyClient, createProfileComfyClient } from "./ComfyClient";
import type { ComfyLauncher } from "./ComfyLauncher";
import { isComfyManagerAvailable } from "./comfyManagerReboot";

const countQueueEntries = (entries: unknown) =>
  Array.isArray(entries) ? entries.length : 0;

const resolveComfyRestartMethod = async ({
  launcher,
  endpoint,
  signal
}: {
  launcher: Pick<ComfyLauncher, "isLaunchedProcessRunning" | "canLaunch">;
  endpoint: string;
  signal?: AbortSignal;
}): Promise<ComfyRestartMethod | null> => {
  signal?.throwIfAborted();
  if (launcher.isLaunchedProcessRunning(endpoint, signal))
    return "mago-launched-process";
  const canLaunch = await launcher.canLaunch(endpoint, signal);
  signal?.throwIfAborted();
  if (!canLaunch) return null;
  if (await isComfyManagerAvailable(endpoint, signal)) return "comfyui-manager";
  return "relaunch-from-install-folder";
};

export const readComfyRestartStatus = async ({
  launcher,
  endpoint,
  signal
}: {
  launcher: Pick<ComfyLauncher, "isLaunchedProcessRunning" | "canLaunch">;
  endpoint: string;
  signal?: AbortSignal;
}): Promise<ComfyRestartStatus> => {
  signal?.throwIfAborted();
  const client = signal
    ? createProfileComfyClient(endpoint, signal)
    : new ComfyClient(endpoint);
  const runningOrQueuedRenderCount = await client
    .getJson("/queue")
    .then(
      (queue) =>
        countQueueEntries(queue.queue_running) +
        countQueueEntries(queue.queue_pending)
    )
    .catch(() => null);
  signal?.throwIfAborted();
  const restartMethod = await resolveComfyRestartMethod({
    launcher,
    endpoint,
    signal
  });
  signal?.throwIfAborted();
  return { restartMethod, runningOrQueuedRenderCount };
};
