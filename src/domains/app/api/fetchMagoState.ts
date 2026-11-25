import { isCloudAccountActive } from "@/platform/cloudAccount";
import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";
import { RendererNetworkPolicyError } from "@/platform/rendererMediaAccess";

const MAGO_STATE_URL = "https://mago-state-25qdhq4f4q-uc.a.run.app/state";
const UNRESPONSIVE_HOST_TIMEOUT_MS = 8000;

export type MagoState = {
  "release-ongoing": boolean;
  version: string;
};

export const fetchMagoState = async (): Promise<MagoState> => {
  if (!isCloudAccountActive()) throw new RendererNetworkPolicyError();
  const deadline = AbortSignal.timeout(UNRESPONSIVE_HOST_TIMEOUT_MS);
  const profile = captureRendererAccountProfile();
  const signal = profile ? AbortSignal.any([deadline, profile]) : deadline;
  const response = await fetch(MAGO_STATE_URL, { signal });
  if (profile?.aborted) {
    await response.body?.cancel(profile.reason);
    profile.throwIfAborted();
  }
  if (!response.ok) {
    throw new Error("Failed to fetch Mago state");
  }

  const result: MagoState = await response.json();
  profile?.throwIfAborted();
  return result;
};
