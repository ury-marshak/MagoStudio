import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { FAL_SHEET_MODEL_21 } from "./constants";
import { useImageRenderModel } from "./useImageRenderModel";

vi.mock("@/platform/renderTarget", () => ({
  isCloudRenderAvailable: () => false
}));

vi.mock("./useSaveProjectSettingsPatch", () => ({
  useSaveProjectSettingsPatch: () => ({ project: { origin: "local" } })
}));

afterEach(() => Reflect.deleteProperty(window, "mago"));

it("waits for fal settings before probing ComfyUI for a reference image model", async () => {
  const fal = Promise.withResolvers<{ keychainAccount: string }>();
  const scriptSetupStatus = vi.fn();
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: {
      externalProviders: { fal: { get: () => fal.promise } },
      comfy: { scriptSetupStatus }
    }
  });
  const client = new QueryClient();
  const { result } = renderHook(
    () => useImageRenderModel("project", "sheet_render_model"),
    {
      wrapper: ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
    }
  );

  expect(result.current.isLoadingProvider).toBe(true);
  expect(scriptSetupStatus).not.toHaveBeenCalled();
  fal.resolve({ keychainAccount: "fal" });
  await waitFor(() =>
    expect(result.current.renderModel).toBe(FAL_SHEET_MODEL_21)
  );
  expect(scriptSetupStatus).not.toHaveBeenCalled();
});

it("defers storyboard model discovery until the storyboard view is active", async () => {
  const scriptSetupStatus = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { comfy: { scriptSetupStatus } }
  });
  const client = new QueryClient();
  const { rerender } = renderHook(
    ({ active }) =>
      useImageRenderModel("project", "storyboard_render_model", active),
    {
      initialProps: { active: false },
      wrapper: ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
    }
  );

  expect(scriptSetupStatus).not.toHaveBeenCalled();
  rerender({ active: true });
  await waitFor(() => expect(scriptSetupStatus).toHaveBeenCalledTimes(1));
});
