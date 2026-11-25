"use client";

import { useMountEffect } from "@hooks/useMountEffect";
/* oxlint-disable custom-react/no-use-effect -- legitimate useEffect for external sync */
import { useUser } from "@platform/identity";
import { useEffect, useRef } from "react";
import ReactGA from "react-ga4";

import { captureRendererCloudAccountScope } from "@/platform/rendererCloudAccountScope";

import { enrichUnsafeMetadata } from "./utils/enrichUnsafeMetadata";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const GOOGLE_TAG_ID = process.env.NEXT_PUBLIC_GOOGLE_TAG_ID;
const CLIENT_ID_RETRY_DELAY_MS = 300;
const MAX_CLIENT_ID_ATTEMPTS = 10;
const GA_CLIENT_ID_STORAGE_KEY = "google_analytics_client_id_pending";

export function GoogleTag(): React.ReactNode {
  const { user, isLoaded } = useUser();
  const hasInitialized = useRef(false);
  const hasLoggedClientId = useRef(false);
  const clientIdAttempts = useRef(0);
  const hasSavedClientId = useRef(false);

  useMountEffect(() => {
    const account = captureRendererCloudAccountScope();
    if (!account.isActive() || !GOOGLE_TAG_ID || hasInitialized.current) {
      return;
    }

    const disable = () => {
      Object.assign(window, { [`ga-disable-${GOOGLE_TAG_ID}`]: true });
    };
    account.signal?.addEventListener("abort", disable, { once: true });
    ReactGA.initialize(GOOGLE_TAG_ID);
    hasInitialized.current = true;
  });

  useEffect(() => {
    const account = captureRendererCloudAccountScope();
    if (
      !account.isActive() ||
      typeof window === "undefined" ||
      !isLoaded ||
      !user
    ) {
      return;
    }

    const existingClientId = user.unsafeMetadata?.google_analytics_user_id as
      | string
      | undefined;

    if (existingClientId && existingClientId !== "") {
      localStorage.removeItem(GA_CLIENT_ID_STORAGE_KEY);
      hasSavedClientId.current = true;
      return;
    }

    const pendingClientId = localStorage.getItem(GA_CLIENT_ID_STORAGE_KEY);

    if (!pendingClientId || pendingClientId.trim() === "") {
      return;
    }

    enrichUnsafeMetadata(user, { google_analytics_user_id: pendingClientId })
      .then(() => {
        if (!account.isActive()) return;
        localStorage.removeItem(GA_CLIENT_ID_STORAGE_KEY);
        hasSavedClientId.current = true;
      })
      .catch((error) => {
        if (!account.isActive()) return;
        console.error(
          "Failed to update google_analytics_user_id in unsafeMetadata:",
          error
        );
      });
  }, [isLoaded, user]);

  useEffect(() => {
    const account = captureRendererCloudAccountScope();
    if (
      !account.isActive() ||
      !GOOGLE_TAG_ID ||
      !hasInitialized.current ||
      hasLoggedClientId.current
    ) {
      return;
    }

    let disposed = false;
    const isActive = () => !disposed && account.isActive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryGetClientId = () => {
      if (!isActive()) return;
      if (typeof window.gtag !== "function") {
        clientIdAttempts.current += 1;
        if (clientIdAttempts.current < MAX_CLIENT_ID_ATTEMPTS) {
          timer = setTimeout(tryGetClientId, CLIENT_ID_RETRY_DELAY_MS);
        }
        return;
      }

      ReactGA.gtag("get", GOOGLE_TAG_ID, "client_id", (clientId: string) => {
        if (
          !isActive() ||
          !clientId ||
          clientId.trim() === "" ||
          hasSavedClientId.current
        ) {
          return;
        }

        if (isLoaded && user) {
          enrichUnsafeMetadata(user, { google_analytics_user_id: clientId })
            .then(() => {
              if (!account.isActive()) return;
              localStorage.removeItem(GA_CLIENT_ID_STORAGE_KEY);
              hasSavedClientId.current = true;
            })
            .catch((error) => {
              if (!account.isActive()) return;
              console.error(
                "Failed to update google_analytics_user_id in unsafeMetadata:",
                error
              );
            });
        } else if (typeof window !== "undefined") {
          localStorage.setItem(GA_CLIENT_ID_STORAGE_KEY, clientId);
        }
      });
      hasLoggedClientId.current = true;
    };

    const stop = () => {
      disposed = true;
      clearTimeout(timer);
      account.signal?.removeEventListener("abort", stop);
    };
    account.signal?.addEventListener("abort", stop, { once: true });
    tryGetClientId();
    return stop;
  }, [isLoaded, user]);

  return null;
}
