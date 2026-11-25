import { useMountEffect } from "@hooks/useMountEffect";
import { useUser } from "@platform/identity";
import React, { useMemo, useState } from "react";
import { ProductFruits } from "react-product-fruits";

import { isCloudAccountActive } from "@/platform/cloudAccount";
import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";

const WORKSPACE_CODE = process.env.NEXT_PUBLIC_PRODUCT_FRUITS_WORKSPACE_CODE;

export const ProductFruitsProvider: React.FC = () => {
  const { user } = useUser();
  const [retired, setRetired] = useState(false);
  useMountEffect(() => {
    const signal = captureRendererAccountProfile();
    if (!signal) return;
    const retire = () => setRetired(true);
    if (signal.aborted) retire();
    else signal.addEventListener("abort", retire, { once: true });
    return () => signal.removeEventListener("abort", retire);
  });

  const signupDate = user?.createdAt;

  const signupDateISO = signupDate
    ? new Date(signupDate).toISOString()
    : undefined;
  const userEmail = user?.emailAddresses[0]?.emailAddress;

  const username = user?.id;
  const userInfo = useMemo(
    () => ({
      username: username ?? "",
      email: userEmail,
      role: "user",
      signUpAt: signupDateISO
    }),
    [username, userEmail, signupDateISO]
  );
  if (retired || !isCloudAccountActive() || !user || !WORKSPACE_CODE) {
    return null;
  }

  return (
    <ProductFruits
      workspaceCode={WORKSPACE_CODE}
      language="en"
      lifeCycle={
        typeof window !== "undefined" && window.mago ? "unmount" : undefined
      }
      user={userInfo}
    />
  );
};
