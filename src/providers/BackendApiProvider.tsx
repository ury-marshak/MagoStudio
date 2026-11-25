"use client";

/* oxlint-disable custom-react/no-use-effect -- legitimate useEffect for external sync */
import { useAuth } from "@platform/identity";
import { hasAccountCookie } from "@utils/hasAccountCookie";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  API_URL,
  initializeBackendApiClient,
  rejectApiKeyInitialization,
  registerUnauthorizedHandler,
  setApiKey
} from "@/lib/backend-api-client";
import { isCloudAccountActive } from "@/platform/cloudAccount";
import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";

export const BackendApiProvider = ({
  children
}: {
  children: React.ReactNode;
}) => {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  // Descendant queries may start during their first commit, before this provider's effect. Set
  // up the request barrier synchronously so they wait for credentials without delaying render.
  useState(() => initializeBackendApiClient(getToken, { waitForApiKey: true }));

  useEffect(() => {
    if (!isLoaded || !isCloudAccountActive()) return;
    const profile = captureRendererAccountProfile();
    if (profile?.aborted) return;

    if (!isSignedIn) {
      router.push(hasAccountCookie() ? "/sign-in" : "/sign-up");
      return;
    }

    const controller = new AbortController();
    const signal = profile
      ? AbortSignal.any([controller.signal, profile])
      : controller.signal;
    // The IPC notification aborts cooperative transports. Recheck with main at
    // settlement as the response can beat the notification into the renderer.
    const isCurrent = () => !signal.aborted && isCloudAccountActive();

    initializeBackendApiClient(getToken);
    registerUnauthorizedHandler(() => {
      if (isCurrent()) router.push("/sign-in");
    });

    let fetchApiUrl = API_URL.replace("/v02", "");
    if (fetchApiUrl.endsWith("/")) {
      fetchApiUrl = fetchApiUrl.slice(0, -1);
    }
    fetchApiUrl = `${fetchApiUrl}/auth`;

    const fetchApiKey = async () => {
      try {
        if (!isCurrent()) return;
        const token = await getToken({ template: "basicToken" });
        if (!isCurrent()) return;
        const response = await axios.post<{
          api_key: string;
          key_id: string;
          enabled: boolean;
        }>(
          fetchApiUrl,
          {},
          {
            signal,
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );

        if (!isCurrent()) return;
        setApiKey(response.data.api_key);
      } catch (error) {
        if (!isCurrent()) return;
        rejectApiKeyInitialization(error);
        console.error("Failed to fetch API key:", error);
        router.push("/api-key-error");
      }
    };

    void fetchApiKey();
    return () => controller.abort();
  }, [getToken, isSignedIn, isLoaded, router]);

  return children;
};
