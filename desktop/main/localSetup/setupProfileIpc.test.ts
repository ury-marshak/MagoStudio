import type { WebContents } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >(),
  pickFolder: vi.fn(),
  download: vi.fn()
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/documents" },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.pickFolder },
  ipcMain: {
    handle: (channel: string, action: never) =>
      mocks.handlers.set(channel, action)
  }
}));
vi.mock("./downloadSetupRequirement", () => ({
  downloadSetupRequirement: mocks.download
}));
vi.mock("./chooseInstallFolder", () => ({
  chooseInstallFolder: mocks.pickFolder
}));

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS } from "../../shared/contracts";
import { registerLocalSetupHandlers } from "../ipc/registerLocalSetupHandlers";
import type { LibrarySettings } from "../librarySettings";

import { deferred } from "./setupTestUtils";

let profile: AbortController;
const captureProfile = vi.fn((_sender: WebContents) => profile.signal);
const settings = {
  getComfyEndpoint: vi.fn(async () => "http://localhost:8188"),
  getVlmBackend: vi.fn(async () => "qwen3-vl-2b-gguf"),
  getScriptTextModel: vi.fn(async () => "qwen38-27b-q5"),
  getTextModelProvider: vi.fn(async () => "local"),
  hasCompletedLocalSetup: vi.fn(async () => false),
  getLocalModelsRoot: vi.fn(async () => null),
  setLocalModelsRoot: vi.fn()
};
const assertInferenceAvailable = vi.fn<() => Promise<void>>();
let drainRetired: () => Promise<void>;
const sender = { id: 42 };
const event = {
  sender,
  senderFrame: { url: `https://${resolveCloudConfig().rendererHost}/` }
};
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!(event, ...args);
const download = (options?: unknown) =>
  invoke(IPC_CHANNELS.localSetupDownloadRequirement, "fixture", options);
const offer = {
  outcome: "node-pack-update-needs-confirmation",
  customNodesFolder: "/existing/custom_nodes"
};
const rotate = () => {
  profile.abort();
  profile = new AbortController();
};
beforeEach(() => {
  vi.clearAllMocks();
  profile = new AbortController();
  assertInferenceAvailable.mockReset().mockResolvedValue(undefined);
  mocks.download.mockReset().mockResolvedValue(offer);
  mocks.pickFolder.mockReset();
  ({ drainRetired } = registerLocalSetupHandlers({
    settings: settings as unknown as LibrarySettings,
    assertInferenceAvailable,
    captureProfile
  }));
});

it("retires a deferred policy lookup before touching Comfy configuration", async () => {
  const policy = deferred<void>();
  assertInferenceAvailable.mockReturnValueOnce(policy.promise);
  const old = expect(download()).rejects.toThrow("Paused");
  await vi.waitFor(() =>
    expect(assertInferenceAvailable).toHaveBeenCalledOnce()
  );
  rotate();
  await drainRetired();
  await old;
  policy.resolve();
  expect(settings.getComfyEndpoint).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it("keeps passive status available and ignores a retired native folder choice", async () => {
  const picker = deferred<unknown>();
  mocks.pickFolder.mockReturnValueOnce(picker.promise);
  const old = expect(
    invoke(IPC_CHANNELS.localSetupChooseFolder)
  ).rejects.toThrow();
  await vi.waitFor(() => expect(mocks.pickFolder).toHaveBeenCalledOnce());
  rotate();
  await drainRetired();
  await old;
  picker.resolve({ folderPath: "/stale", freeGigabytes: 1 });
  await expect(
    invoke(IPC_CHANNELS.localSetupInstallerStatus)
  ).resolves.toMatchObject({ hasCompletedInstall: false });
  expect(settings.hasCompletedLocalSetup).toHaveBeenCalledWith({
    allowNetwork: false
  });
  expect(settings.setLocalModelsRoot).not.toHaveBeenCalled();
  expect(captureProfile).toHaveBeenCalledExactlyOnceWith(sender);
  expect(assertInferenceAvailable).not.toHaveBeenCalled();
});

it("acknowledges explicit pause only after issued cleanup", async () => {
  const close = deferred<void>();
  const issued = deferred<void>();
  mocks.download.mockImplementationOnce(
    async (_window, _settings, _name, signal, { attempt }) => {
      await attempt.issue(async () => {
        issued.resolve();
        await close.promise;
        signal.throwIfAborted();
      });
    }
  );
  const started = expect(download()).rejects.toThrow("Paused");
  await issued.promise;
  const paused = vi.fn();
  const barrier = invoke(IPC_CHANNELS.localSetupPauseDownload, "fixture").then(
    paused
  );
  await Promise.resolve();
  expect(paused).not.toHaveBeenCalled();
  close.resolve();
  await Promise.all([started, barrier]);
  expect(paused).toHaveBeenCalledOnce();
});

it("does not await a late approval offer or let it overwrite a replacement attempt", async () => {
  const deferredOffer = deferred<unknown>();
  mocks.download.mockReturnValueOnce(deferredOffer.promise);
  const old = expect(download()).rejects.toThrow("Paused");
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  rotate();
  const replacement = (await download()) as typeof offer & {
    approvalToken: string;
  };
  await old;
  deferredOffer.resolve(offer);
  await Promise.resolve();
  mocks.download.mockResolvedValue({ outcome: "saved" });
  await expect(
    download({
      replaceExistingNodePackIn: offer.customNodesFolder,
      approvalToken: replacement.approvalToken
    })
  ).resolves.toEqual({ outcome: "saved" });
});

it("consumes only the matching current one-time approval across reused senders and destinations", async () => {
  const old = (await download()) as typeof offer & { approvalToken: string };
  rotate();
  rotate();
  const fresh = (await download()) as typeof offer & { approvalToken: string };
  const approve = (approvalToken?: string) =>
    download({
      replaceExistingNodePackIn: offer.customNodesFolder,
      approvalToken
    });
  expect(old.approvalToken).not.toBe(fresh.approvalToken);
  await expect(approve(old.approvalToken)).rejects.toThrow(
    "Confirm the node pack update"
  );
  await expect(approve()).rejects.toThrow("Confirm the node pack update");
  mocks.download.mockResolvedValue({ outcome: "saved" });
  await expect(approve(fresh.approvalToken)).resolves.toEqual({
    outcome: "saved"
  });
  await expect(approve(fresh.approvalToken)).rejects.toThrow(
    "Confirm the node pack update"
  );
});
