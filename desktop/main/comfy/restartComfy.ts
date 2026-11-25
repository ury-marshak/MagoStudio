import type { ComfyLauncher } from "./ComfyLauncher";
import { rebootThroughComfyManager } from "./comfyManagerReboot";

export const restartComfy = async ({
  launcher,
  endpoint,
  signal
}: {
  launcher: Pick<
    ComfyLauncher,
    | "isLaunchedProcessRunning"
    | "restartLaunchedProcess"
    | "relaunchProcessStartedOutsideMago"
    | "waitUntilEndpointStopsAnswering"
  >;
  endpoint: string;
  signal?: AbortSignal;
}): Promise<void> => {
  signal?.throwIfAborted();
  if (launcher.isLaunchedProcessRunning(endpoint, signal)) {
    await launcher.restartLaunchedProcess(endpoint, signal);
  } else {
    const accepted = await rebootThroughComfyManager(endpoint, signal);
    signal?.throwIfAborted();
    if (accepted) {
      const stopped = await launcher
        .waitUntilEndpointStopsAnswering(endpoint, signal)
        .then(() => true)
        .catch(() => false);
      signal?.throwIfAborted();
      if (stopped) return;
    }
    await launcher.relaunchProcessStartedOutsideMago(endpoint, signal);
  }
  signal?.throwIfAborted();
};
