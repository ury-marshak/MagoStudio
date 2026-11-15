import { useSyncExternalStore } from "react";

import { rendererLibrary } from "./rendererLibraryWork";

/** Capture before React Query can queue/retry a callback. Navigation within a
 * library retains its work; replacement gets distinct preview query keys. */
export function useRendererLibraryWork() {
  const version = useSyncExternalStore(
    rendererLibrary.subscribe,
    rendererLibrary.getSnapshot,
    rendererLibrary.getSnapshot
  );
  const work = rendererLibrary.capture();
  return { work, libraryVersion: version };
}
