import "@config/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { queryKeys } from "@/queryKeys";

import { LocalSettingsProvidersTab } from "./LocalSettingsProvidersTab";

afterEach(() => Reflect.deleteProperty(window, "mago"));

const falBridge = () => ({
  get: vi.fn().mockResolvedValue(null),
  save: vi.fn(),
  check: vi.fn().mockResolvedValue(undefined)
});

it("saves, checks, and removes external text settings independently of vision", async () => {
  const config = {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "example/text",
    reasoningEffort: "low",
    keychainAccount: "openrouter"
  };
  const get = vi.fn().mockResolvedValue(null);
  const save = vi
    .fn()
    .mockResolvedValueOnce(config)
    .mockResolvedValueOnce(null);
  const check = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { externalProviders: { get, save, check, fal: falBridge() } }
  });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <LocalSettingsProvidersTab />
    </QueryClientProvider>
  );

  const text = within(screen.getByRole("form", { name: "Text provider" }));
  const model = text.getByLabelText("Model ID");
  const checkButton = text.getByRole("button", { name: "Check connection" });
  await waitFor(() => expect(model).toBeEnabled());
  expect(checkButton).toBeDisabled();
  fireEvent.change(model, { target: { value: config.model } });
  fireEvent.change(text.getByLabelText("Reasoning effort"), {
    target: { value: config.reasoningEffort }
  });
  fireEvent.click(text.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(checkButton).toBeEnabled());
  expect(save).toHaveBeenCalledExactlyOnceWith("text", config);
  expect(check).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: queryKeys.externalProviders.configuredText
  });

  fireEvent.click(checkButton);
  expect(
    await text.findByText("Model found. No generation was requested.")
  ).toBeVisible();
  expect(check).toHaveBeenCalledExactlyOnceWith("text");

  fireEvent.click(text.getByRole("button", { name: "Remove" }));
  expect(await text.findByText("Provider removed.")).toBeVisible();
  expect(save).toHaveBeenLastCalledWith("text", null);
  expect(checkButton).toBeDisabled();
  expect(
    within(
      screen.getByRole("form", { name: "Vision provider" })
    ).getByLabelText("Model ID")
  ).toHaveValue("");
});

it("saves the fal account and Director defaults and labels the local check", async () => {
  const fal = falBridge();
  const config = {
    keychainAccount: "fal",
    referenceImageModel: "fal_minimax_h3_image",
    storyboardImageModel: "fal_nano_banana_2_1",
    shotProvider: "local-comfy"
  };
  fal.save.mockResolvedValueOnce(config).mockResolvedValueOnce(null);
  const get = vi.fn().mockResolvedValue(null);
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { externalProviders: { get, fal } }
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LocalSettingsProvidersTab />
    </QueryClientProvider>
  );

  const form = within(screen.getByRole("form", { name: "fal.ai" }));
  const account = form.getByLabelText("Keychain account");
  const checkButton = form.getByRole("button", { name: "Check Keychain" });
  await waitFor(() => expect(account).toBeEnabled());
  expect(form.queryByLabelText("API base URL")).not.toBeInTheDocument();
  expect(form.queryByLabelText("Model ID")).not.toBeInTheDocument();
  expect(checkButton).toBeDisabled();
  fireEvent.change(account, { target: { value: " fal " } });
  fireEvent.change(form.getByLabelText("Default reference image model"), {
    target: { value: config.referenceImageModel }
  });
  fireEvent.change(form.getByLabelText("Default storyboard model"), {
    target: { value: config.storyboardImageModel }
  });
  fireEvent.change(form.getByLabelText("Default video shot model"), {
    target: { value: config.shotProvider }
  });
  fireEvent.click(form.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(checkButton).toBeEnabled());
  expect(fal.save).toHaveBeenCalledExactlyOnceWith(config);
  expect(fal.check).not.toHaveBeenCalled();
  fireEvent.click(checkButton);
  expect(
    await form.findByText(
      "Keychain entry is readable. fal.ai was not contacted."
    )
  ).toBeVisible();
  expect(fal.check).toHaveBeenCalledExactlyOnceWith();

  fireEvent.click(form.getByRole("button", { name: "Remove" }));
  expect(await form.findByText("Provider removed.")).toBeVisible();
  expect(fal.save).toHaveBeenLastCalledWith(null);
});
