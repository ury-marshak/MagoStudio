import { useUser } from "@platform/identity";
import React from "react";
import { ProductFruits } from "react-product-fruits";

import { isCloudAccountActive } from "@/platform/cloudAccount";

const WORKSPACE_CODE = process.env.NEXT_PUBLIC_PRODUCT_FRUITS_WORKSPACE_CODE;

export const ProductFruitsProvider: React.FC = () => {
  const { user } = useUser();
  const signupDate = user?.createdAt;

  const signupDateISO = signupDate
    ? new Date(signupDate).toISOString()
    : undefined;
  const userEmail = user?.emailAddresses[0].emailAddress;

  if (!isCloudAccountActive() || !user || !WORKSPACE_CODE) {
    return null;
  }

  const userInfo = {
    username: user.id,
    email: userEmail,
    role: "user",
    signUpAt: signupDateISO
  };

  return (
    <ProductFruits
      workspaceCode={WORKSPACE_CODE}
      language="en"
      user={userInfo}
    />
  );
};
