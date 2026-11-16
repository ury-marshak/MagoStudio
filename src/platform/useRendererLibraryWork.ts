import { useMemo, useSyncExternalStore } from "react";

import { rendererLibrary } from "./rendererLibraryWork";

/** Capture before React Query can queue/retry a callback. Navigation within a
 * library retains its work; replacement gets distinct preview query keys. */
export function useRendererLibraryWork() {
  const version = useSyncExternalStore(
    rendererLibrary.subscribe,
    rendererLibrary.getSnapshot,
    rendererLibrary.getSnapshot
  );
  // A stable effect dependency within one library; still freeze origin during
  // render, before any queued callback or asynchronous dispatch can run.
  return useMemo(
    () => ({ work: rendererLibrary.capture(), libraryVersion: version }),
    [version]
  );
}
