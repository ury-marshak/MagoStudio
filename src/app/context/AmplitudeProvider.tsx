import * as amplitude from "@amplitude/analytics-browser";
import { AmplitudeUserTracking } from "@config/AmplitudeUserTracking";
import { isLongFormRunPath } from "@domains/longFormRun/utils/isLongFormRunPath";
import { useMountEffect } from "@hooks/useMountEffect";
import { useState } from "react";

import { captureRendererCloudAccountScope } from "@/platform/rendererCloudAccountScope";

import { getAmplitudeAutocaptureOptions } from "./getAmplitudeAutocaptureOptions";

const AMPLITUDE_API_KEY = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY;

interface Props {
  children: React.ReactNode;
}

export const AmplitudeProvider: React.FC<Props> = ({ children }) => {
  const [isAmplitudeInitialized, setIsAmplitudeInitialized] = useState(false);

  useMountEffect(() => {
    const account = captureRendererCloudAccountScope();
    if (!account.isActive()) return;
    if (!AMPLITUDE_API_KEY) {
      if (process.env.NODE_ENV === "production") {
        console.error("AMPLITUDE_API_KEY is not set");
      }
      return;
    }

    let disposed = false;
    const isActive = () => !disposed && account.isActive();
    const optOut = () => amplitude.setOptOut(true);
    account.signal?.addEventListener("abort", optOut, { once: true });

    const initialized = amplitude
      .init(AMPLITUDE_API_KEY, undefined, {
        autocapture: getAmplitudeAutocaptureOptions()
      })
      .promise.then(() => {
        if (account.signal?.aborted) optOut();
        if (!isActive()) return false;
        setIsAmplitudeInitialized(true);
        return true;
      })
      .catch((error) => {
        if (isActive()) console.error("Amplitude initialization failed", error);
        return false;
      });

    if (!isLongFormRunPath(window.location.pathname)) {
      void Promise.all([
        initialized,
        import("@amplitude/plugin-session-replay-browser")
      ])
        .then(async ([ready, { sessionReplayPlugin }]) => {
          if (!ready || !isActive()) return;
          const plugin = sessionReplayPlugin({
            sampleRate: 0.5,
            privacyConfig: { defaultMaskLevel: "conservative" },
            useWebWorker: true
          });
          const remove = () => {
            void amplitude.remove(plugin.name).promise.catch(() => {});
          };
          try {
            await amplitude.add(plugin).promise;
          } catch (error) {
            // A setup that rejects may not have registered for SDK removal.
            if (account.signal?.aborted) await plugin.teardown?.();
            throw error;
          }
          // Removal during setup can miss a not-yet-registered plugin.
          if (!account.signal) return;
          if (!account.isActive()) remove();
          else account.signal.addEventListener("abort", remove, { once: true });
        })
        .catch((error) => {
          if (isActive())
            console.error("Session replay plugin failed to load", error);
        });
    }
    return () => {
      disposed = true;
      // Keep the retirement opt-out/removal for the window-owned SDK.
    };
  });

  return (
    <>
      {isAmplitudeInitialized && <AmplitudeUserTracking />}
      {children}
    </>
  );
};
