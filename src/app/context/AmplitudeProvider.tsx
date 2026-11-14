import * as amplitude from "@amplitude/analytics-browser";
import { AmplitudeUserTracking } from "@config/AmplitudeUserTracking";
import { isLongFormRunPath } from "@domains/longFormRun/utils/isLongFormRunPath";
import { useMountEffect } from "@hooks/useMountEffect";
import { useState } from "react";

import { isCloudAccountActive } from "@/platform/cloudAccount";

import { getAmplitudeAutocaptureOptions } from "./getAmplitudeAutocaptureOptions";

const AMPLITUDE_API_KEY = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY;

interface Props {
  children: React.ReactNode;
}

export const AmplitudeProvider: React.FC<Props> = ({ children }) => {
  const [isAmplitudeInitialized, setIsAmplitudeInitialized] = useState(false);

  useMountEffect(() => {
    if (!isCloudAccountActive()) return;
    if (!AMPLITUDE_API_KEY) {
      if (process.env.NODE_ENV === "production") {
        console.error("AMPLITUDE_API_KEY is not set");
      }
      return;
    }

    amplitude
      .init(AMPLITUDE_API_KEY, undefined, {
        autocapture: getAmplitudeAutocaptureOptions()
      })
      .promise.then(() => {
        if (isCloudAccountActive()) setIsAmplitudeInitialized(true);
      })
      .catch((error) => {
        console.error("Amplitude initialization failed", error);
      });

    if (!isLongFormRunPath(window.location.pathname)) {
      import("@amplitude/plugin-session-replay-browser")
        .then(({ sessionReplayPlugin }) => {
          if (!isCloudAccountActive()) return;
          amplitude.add(
            sessionReplayPlugin({
              sampleRate: 0.5,
              privacyConfig: { defaultMaskLevel: "conservative" },
              useWebWorker: true
            })
          );
        })
        .catch((error) => {
          console.error("Session replay plugin failed to load", error);
        });
    }
  });

  return (
    <>
      {isAmplitudeInitialized && <AmplitudeUserTracking />}
      {children}
    </>
  );
};
