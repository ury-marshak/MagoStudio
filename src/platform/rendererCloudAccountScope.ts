import { isCloudAccountActive } from "./cloudAccount";
import { captureRendererAccountProfile } from "./rendererAccountProfile";

// Retain the originating profile even if a different bridge is installed.
export const captureRendererCloudAccountScope = () => {
  const signal = captureRendererAccountProfile();
  return {
    signal,
    isActive: () => !signal?.aborted && isCloudAccountActive()
  };
};
