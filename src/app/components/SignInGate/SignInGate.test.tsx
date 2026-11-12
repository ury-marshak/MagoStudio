import "@config/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SignInGateBoundary } from "./SignInGate";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@platform/identity", () => ({
  readAppMode: () => "unchosen",
  SignIn: () => <div>Mago sign-in</div>,
  SignUp: () => <div>Mago sign-up</div>,
  useAuth: () => ({ isSignedIn: false })
}));

afterEach(() => {
  Reflect.deleteProperty(window, "mago");
  localStorage.clear();
});

it("opens the local editor without asking the next window to start ComfyUI setup", () => {
  const chooseMode = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { account: { chooseMode } }
  });
  render(
    <SignInGateBoundary>
      <div>Editor</div>
    </SignInGateBoundary>
  );

  fireEvent.click(screen.getByRole("button", { name: "Open local editor" }));

  expect(chooseMode).toHaveBeenCalledExactlyOnceWith("offline");
  expect(
    localStorage.getItem("mago.localSetupWizard.openOnNextLaunch")
  ).toBeNull();
});
