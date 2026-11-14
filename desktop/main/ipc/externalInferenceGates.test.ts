import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >(),
  launch: vi.fn(),
  validate: vi.fn(),
  modelStatus: vi.fn(),
  scriptSetup: vi.fn(),
  restartStatus: vi.fn(),
  restart: vi.fn(),
  installerStart: vi.fn(),
  modelGroups: vi.fn(),
  download: vi.fn(),
  downloads: vi.fn(),
  hardware: vi.fn()
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused-audit-profile" },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => Promise<unknown>
    ) => mocks.handlers.set(channel, handler)
  }
}));
vi.mock("../comfy/ComfyLauncher", () => ({
  ComfyLauncher: class {
    launch = mocks.launch;
  }
}));
vi.mock("../imageRenders/comfyQwenClient", () => ({
  ComfyQwenClient: class {
    validate = mocks.validate;
  }
}));
vi.mock("../imageRenders/comfyModelValidation", () => ({
  isComfyRenderModelName: () => true,
  probeComfyRenderModel: mocks.modelStatus
}));
vi.mock("../localSetup/probeScriptSetup", () => ({
  probeScriptSetup: mocks.scriptSetup
}));
vi.mock("../comfy/readComfyRestartStatus", () => ({
  readComfyRestartStatus: mocks.restartStatus
}));
vi.mock("../comfy/restartComfy", () => ({ restartComfy: mocks.restart }));
vi.mock("../localSetup/starterInstaller", () => ({
  StarterInstaller: class {
    start = mocks.installerStart;
    status = () => ({ state: "idle" });
  }
}));
vi.mock("../localSetup/readLocalModelGroupsStatus", () => ({
  readLocalModelGroupsStatus: mocks.modelGroups
}));
vi.mock("../localSetup/downloadSetupRequirement", () => ({
  downloadSetupRequirement: mocks.download
}));
vi.mock("../localSetup/downloadSetupRequirements", () => ({
  downloadSetupRequirements: mocks.downloads
}));
vi.mock("../localSetup/probeHardware", () => ({
  probeHardware: mocks.hardware
}));

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS } from "../../shared/contracts";
import type { LibrarySettings } from "../librarySettings";
import { createExternalProviderSettings } from "../providers/externalProviderSettings";

import { registerComfyHandlers } from "./registerComfyHandlers";
import { registerLocalSetupHandlers } from "./registerLocalSetupHandlers";

let directory: string;
const transport = vi.fn();
const settings = {
  getComfyEndpoint: vi.fn(async () => "http://localhost:8188"),
  getVlmBackend: vi.fn(async () => "qwen3-vl-2b-gguf"),
  getScriptTextModel: vi.fn(async () => "qwen38-27b-q5"),
  getTextModelProvider: vi.fn(async () => "local"),
  hasCompletedLocalSetup: vi.fn(async () => false)
};
const trusted = {
  senderFrame: { url: `https://${resolveCloudConfig().rendererHost}/` }
};
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!(trusted, ...args);
const operations = [
  [IPC_CHANNELS.comfyRestartStatus],
  [IPC_CHANNELS.comfyRestart],
  [IPC_CHANNELS.comfyLaunch],
  [IPC_CHANNELS.comfyScriptSetupStatus],
  [IPC_CHANNELS.comfySave, {}],
  [IPC_CHANNELS.comfyCheck, "http://localhost:8188"],
  ...[
    "wan_animate_2_2",
    "wan_vace_2_1",
    "mago_animate",
    "ltx_2_3_spatial_upscaler"
  ].map((model) => [IPC_CHANNELS.comfyModelStatus, { model }] as const),
  [IPC_CHANNELS.localSetupInstallerStart, {}],
  [IPC_CHANNELS.localSetupModelGroupsStatus],
  [IPC_CHANNELS.localSetupDownloadRequirement, "SAM2"],
  [
    IPC_CHANNELS.localSetupDownloadRequirements,
    "supporting",
    ["depth", "pose"]
  ],
  [IPC_CHANNELS.localSetupProbeHardware]
] as const;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mago-ipc-inference-audit-"));
  vi.clearAllMocks();
  mocks.handlers.clear();
  transport.mockRejectedValue(new Error("Unexpected transport"));
  vi.stubGlobal("fetch", transport);
  const assertInferenceAvailable = createExternalProviderSettings(
    () => directory
  ).assertLegacyInferenceAvailable;
  registerComfyHandlers(
    settings as unknown as LibrarySettings,
    assertInferenceAvailable
  );
  registerLocalSetupHandlers({
    settings: settings as unknown as LibrarySettings,
    assertInferenceAvailable
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it.each(["fal", "text", "vision"])(
  "gates local probes, launch and supporting-model downloads with only %s configured",
  async (capability) => {
    await writeFile(
      path.join(directory, "external-providers.json"),
      JSON.stringify({
        [capability]:
          capability === "fal"
            ? { keychainAccount: "nonexistent" }
            : {
                baseUrl: "https://inference.invalid",
                model: "fixture",
                keychainAccount: "nonexistent"
              }
      })
    );
    for (const [channel, ...args] of operations)
      await expect(invoke(channel, ...args)).rejects.toThrow(
        "unavailable while external providers"
      );
    for (const [name, mock] of Object.entries(mocks)) {
      if (name !== "handlers") expect(mock).not.toHaveBeenCalled();
    }
    expect(settings.getComfyEndpoint).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    // Local metadata remains readable without probes; the closed wizard uses it.
    await expect(invoke(IPC_CHANNELS.comfyGet)).resolves.toMatchObject({
      endpoint: "http://localhost:8188"
    });
    await expect(
      invoke(IPC_CHANNELS.localSetupInstallerStatus)
    ).resolves.toMatchObject({ hasCompletedInstall: false });
    expect(transport).not.toHaveBeenCalled();
  }
);

it("checks trust before reading inference configuration", async () => {
  await writeFile(
    path.join(directory, "external-providers.json"),
    "broken JSON"
  );
  for (const [channel, ...args] of operations)
    await expect(
      mocks.handlers.get(channel)!(
        { senderFrame: { url: "https://untrusted.invalid/" } },
        ...args
      )
    ).rejects.toThrow("untrusted renderer");
});

it("fails closed on corrupt settings rather than probing a legacy endpoint", async () => {
  await writeFile(
    path.join(directory, "external-providers.json"),
    "broken JSON"
  );
  for (const [channel, ...args] of operations)
    await expect(invoke(channel, ...args)).rejects.toThrow("invalid JSON");
  expect(transport).not.toHaveBeenCalled();
  expect(settings.getComfyEndpoint).not.toHaveBeenCalled();
});

it("retains explicit legacy probes without external configuration", async () => {
  await invoke(IPC_CHANNELS.comfyModelStatus, { model: "wan_vace_2_1" });
  expect(mocks.modelStatus).toHaveBeenCalledExactlyOnceWith(
    "http://localhost:8188",
    "wan_vace_2_1",
    {}
  );
  await invoke(IPC_CHANNELS.localSetupModelGroupsStatus);
  expect(mocks.modelGroups).toHaveBeenCalledOnce();
});
