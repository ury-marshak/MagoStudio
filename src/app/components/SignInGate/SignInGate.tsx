/* oxlint-disable custom-react/no-use-effect -- Clerk owns the sign-in result, so persisting the chosen mode is external sync */
import { Text } from "@components/Text";
import { readAppMode, SignIn, SignUp, useAuth } from "@platform/identity";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components/Button";
import { useTranslation } from "react-i18next";

/** First-launch choice between Mago sign-in and the local editor. */
export const SignInGate = () => {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { isSignedIn } = useAuth();
  const hasRequestedModeRef = useRef(false);
  const [isEnteringOfflineApp, setIsEnteringOfflineApp] = useState(false);

  // The main process persists the choice and rebuilds the window, so there is
  // no success path to handle here — this view goes away with the window.
  useEffect(() => {
    if (!isSignedIn || hasRequestedModeRef.current) return;
    hasRequestedModeRef.current = true;
    void window.mago?.account?.chooseMode("cloud").catch(() => {
      hasRequestedModeRef.current = false;
    });
  }, [isSignedIn]);

  const openLocalEditor = () => {
    if (hasRequestedModeRef.current) return;
    hasRequestedModeRef.current = true;
    setIsEnteringOfflineApp(true);
    void window.mago?.account?.chooseMode("offline").catch(() => {
      hasRequestedModeRef.current = false;
      setIsEnteringOfflineApp(false);
    });
  };

  const isSignUpRoute = pathname?.startsWith("/sign-up") ?? false;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 overflow-auto bg-[url('/assets/images/preview-background.png')] bg-cover bg-no-repeat p-4">
      <div className="overflow-hidden rounded-3xl bg-surface-primary text-glyph-primary backdrop-blur-xl">
        {isSignUpRoute ? (
          <SignUp signInUrl="/sign-in" />
        ) : (
          <SignIn signUpUrl="/sign-up" />
        )}
      </div>

      <Button
        className="cursor-pointer data-[disabled]:cursor-default"
        isDisabled={isEnteringOfflineApp}
        onPress={openLocalEditor}
      >
        <Text
          component="span"
          variant="sm"
          color="glyph-secondary"
          decoration="underline"
        >
          {t("signInGate.openLocalEditor", {
            defaultValue: "Open local editor"
          })}
        </Text>
      </Button>
    </div>
  );
};

/** Renders the gate in place of the app until the choice has been made. */
export const SignInGateBoundary = ({
  children
}: {
  children: React.ReactNode;
}) => {
  const [mode] = useState(readAppMode);
  if (mode !== "unchosen") return children;
  return <SignInGate />;
};
