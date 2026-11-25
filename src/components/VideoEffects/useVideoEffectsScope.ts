import { useSyncExternalStore } from "react";

import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

export const useVideoEffectsScope = () => {
  const scope = useRendererLibraryWork();
  const profile = captureRendererAccountProfile();
  const retired = useSyncExternalStore(
    (notify) => {
      profile?.addEventListener("abort", notify);
      return () => profile?.removeEventListener("abort", notify);
    },
    () => !!profile?.aborted,
    () => false
  );
  return { ...scope, profile, retired };
};
