"use client";

import { useMountEffect } from "@hooks/useMountEffect";
/* oxlint-disable custom-react/no-use-effect -- legitimate useEffect for external sync */
import { useUser } from "@platform/identity";
import { useEffect } from "react";

import { captureRendererCloudAccountScope } from "@/platform/rendererCloudAccountScope";

import { enrichUnsafeMetadata } from "./utils/enrichUnsafeMetadata";

const REFERRAL_ID_STORAGE_KEY = "referral_id_pending";

export function ReferralTracking(): null {
  const { user, isLoaded } = useUser();

  useMountEffect(() => {
    const account = captureRendererCloudAccountScope();
    if (!account.isActive()) return;
    let disposed = false;
    window.rewardful?.("ready", function () {
      if (disposed || !account.isActive()) return;
      const referral = window.Rewardful?.referral;
      if (referral) {
        localStorage.setItem(REFERRAL_ID_STORAGE_KEY, referral);
      }
    });
    return () => {
      disposed = true;
    };
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

    const existingReferralId = user.unsafeMetadata?.referral_id as
      | string
      | undefined;

    if (existingReferralId && existingReferralId !== "") {
      localStorage.removeItem(REFERRAL_ID_STORAGE_KEY);
      return;
    }

    const pendingReferralId = localStorage.getItem(REFERRAL_ID_STORAGE_KEY);

    if (!pendingReferralId || pendingReferralId.trim() === "") {
      return;
    }

    enrichUnsafeMetadata(user, { referral_id: pendingReferralId })
      .then(() => {
        if (!account.isActive()) return;
        localStorage.removeItem(REFERRAL_ID_STORAGE_KEY);
      })
      .catch((error) => {
        if (!account.isActive()) return;
        console.error("Failed to update referral_id in unsafeMetadata:", error);
      });
  }, [isLoaded, user]);

  return null;
}
