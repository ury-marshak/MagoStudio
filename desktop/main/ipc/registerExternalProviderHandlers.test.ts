import { expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared/contracts";
import { createExternalProviderSettings } from "../providers/externalProviderSettings";

import { registerExternalProviderHandlers } from "./registerExternalProviderHandlers";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  requireTrustedSender: vi.fn(),
  readExternalProviderKey: vi.fn(),
  probeOpenAiCompatible: vi.fn()
}));

vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("./trustedSender", () => ({
  requireTrustedSender: mocks.requireTrustedSender
}));
vi.mock("../providers/externalProviderSettings", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../providers/externalProviderSettings")
  >()),
  readExternalProviderKey: mocks.readExternalProviderKey
}));
vi.mock("../providers/openAiCompatible", () => ({
  probeOpenAiCompatible: mocks.probeOpenAiCompatible
}));

it("checks the saved fal key locally without returning it or probing a provider", async () => {
  const settings = createExternalProviderSettings(() => "/unused");
  vi.spyOn(settings, "getFal").mockResolvedValue({ keychainAccount: "fal" });
  mocks.readExternalProviderKey.mockResolvedValue("mock-fal-secret");
  registerExternalProviderHandlers(settings);

  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.externalProvidersCheck
  )?.[1];
  const event = {};
  await expect(handler(event, "fal")).resolves.toBeUndefined();
  expect(mocks.requireTrustedSender).toHaveBeenCalledExactlyOnceWith(event);
  expect(mocks.readExternalProviderKey).toHaveBeenCalledExactlyOnceWith("fal");
  expect(mocks.probeOpenAiCompatible).not.toHaveBeenCalled();
});
