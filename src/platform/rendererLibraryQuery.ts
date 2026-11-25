import { useQueryClient } from "@tanstack/react-query";

import { isLocalApp } from "./localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "./rendererLibraryWork";
import { useRendererLibraryWork } from "./useRendererLibraryWork";

/** Append, rather than prepend, so existing family and per-ID invalidations
 * still match. Exact cache readers/writers must use the scoped key. */
export const libraryQueryKey = <T extends readonly unknown[]>(
  key: T,
  version = rendererLibrary.getSnapshot()
) => (isLocalApp ? ([...key, { libraryVersion: version }] as const) : key);

export const isCurrentLibraryQueryKey = (key: readonly unknown[]) => {
  if (!isLocalApp) return true;
  const scope = key.at(-1);
  return (
    typeof scope === "object" &&
    scope !== null &&
    "libraryVersion" in scope &&
    scope.libraryVersion === rendererLibrary.getSnapshot()
  );
};

// TanStack Query's client-side default when no retry policy is supplied.
const DEFAULT_QUERY_RETRIES = 3;

type QueryRetry =
  | boolean
  | number
  | ((failures: number, error: Error) => boolean);

export const useRendererLibraryQueryScope = () => {
  const { work, libraryVersion } = useRendererLibraryWork();
  const client = useQueryClient();
  return {
    work,
    libraryVersion,
    key: <T extends readonly unknown[]>(key: T) =>
      libraryQueryKey(key, libraryVersion),
    run: <T>(read: () => Promise<T>) => runRendererLibraryRequest(work, read),
    active: !work.signal.aborted,
    retry: (key: readonly unknown[], retry?: QueryRetry) => {
      if (!isLocalApp) return retry;
      const policy =
        retry ??
        client.getQueryDefaults(key).retry ??
        client.getDefaultOptions().queries?.retry ??
        DEFAULT_QUERY_RETRIES;
      return (failures: number, error: Error) =>
        !work.signal.aborted &&
        (typeof policy === "function"
          ? policy(failures, error)
          : typeof policy === "number"
            ? failures < policy
            : policy);
    }
  };
};
