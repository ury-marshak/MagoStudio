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
    getLaunchPath = async () => null;
    getLaunchedProcess = () => null;
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
  hasCompletedLocalSetup: vi.fn(async () => false),
  setInferredComfyInstall: vi.fn(async () => {}),
  markLocalSetupCompleted: vi.fn(async () => {}),
  saveComfyConfiguration: vi.fn(async () => {})
};
const trusted = {
  senderFrame: { url: `https://${resolveCloudConfig().rendererHost}/` },
  sender: {}
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
    {},
    expect.any(AbortSignal)
  );
  await invoke(IPC_CHANNELS.localSetupModelGroupsStatus);
  expect(mocks.modelGroups).toHaveBeenCalledOnce();
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const registerOwnedComfy = (
  assertInferenceAvailable: () => Promise<void>,
  captureInferenceProfile: NonNullable<
    NonNullable<
      Parameters<typeof registerComfyHandlers>[2]
    >["captureInferenceProfile"]
  >
) =>
  registerComfyHandlers(
    settings as unknown as LibrarySettings,
    assertInferenceAvailable,
    { captureInferenceProfile }
  );

it("captures before policy and refuses launch from a retired profile across an ABA round trip", async () => {
  const policy = deferred<void>();
  const assertInferenceAvailable = vi
    .fn(async () => {})
    .mockReturnValueOnce(policy.promise);
  let current = new AbortController();
  const capture = vi.fn(() => current.signal);
  registerOwnedComfy(assertInferenceAvailable, capture);
  const stale = invoke(IPC_CHANNELS.comfyLaunch);
  const rejected = expect(stale).rejects.toHaveProperty("name", "AbortError");
  expect(capture).toHaveBeenCalledExactlyOnceWith(trusted.sender);
  current.abort();
  current = new AbortController();
  current.abort();
  current = new AbortController();
  await invoke(IPC_CHANNELS.comfyLaunch);
  policy.resolve();
  await rejected;
  expect(settings.getComfyEndpoint).toHaveBeenCalledOnce();
  expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      endpoint: "http://localhost:8188",
      signal: expect.any(AbortSignal)
    })
  );
});

it("drops a late launch response and a late inferred installation instead of publishing readiness", async () => {
  const launch = deferred<void>();
  const setup = deferred<{ comfyRoot: string }>();
  mocks.launch.mockReturnValueOnce(launch.promise);
  mocks.scriptSetup.mockReturnValueOnce(setup.promise);
  const controller = new AbortController();
  registerOwnedComfy(
    async () => {},
    () => controller.signal
  );
  const launches = expect(
    invoke(IPC_CHANNELS.comfyLaunch)
  ).rejects.toHaveProperty("name", "AbortError");
  const probes = expect(
    invoke(IPC_CHANNELS.comfyScriptSetupStatus)
  ).rejects.toHaveProperty("name", "AbortError");
  await vi.waitFor(() => {
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.scriptSetup).toHaveBeenCalledOnce();
  });
  controller.abort();
  launch.resolve();
  setup.resolve({ comfyRoot: "/app/ComfyUI" });
  await Promise.all([launches, probes]);
  expect(settings.setInferredComfyInstall).not.toHaveBeenCalled();
});

it("does not probe or publish setup completion after a save's post-commit profile retires", async () => {
  const controller = new AbortController();
  const validation = deferred<void>();
  const staleCheck = deferred<void>();
  mocks.validate
    .mockReturnValueOnce(staleCheck.promise)
    .mockReturnValueOnce(validation.promise);
  registerOwnedComfy(
    async () => {},
    () => controller.signal
  );
  const stale = expect(
    invoke(IPC_CHANNELS.comfyCheck, "http://localhost:8188")
  ).rejects.toHaveProperty("name", "AbortError");
  await vi.waitFor(() => expect(mocks.validate).toHaveBeenCalledOnce());
  const save = expect(
    invoke(
      IPC_CHANNELS.comfySave,
      {
        endpoint: "http://localhost:8188",
        vlmBackend: "qwen3-vl-2b-gguf",
        scriptTextModel: "qwen38-27b-q3"
      },
      { completeSetupOnConnection: true }
    )
  ).rejects.toHaveProperty("name", "AbortError");
  await vi.waitFor(() => expect(mocks.validate).toHaveBeenCalledTimes(2));
  expect(settings.saveComfyConfiguration).toHaveBeenCalledOnce();
  staleCheck.resolve();
  await stale;
  controller.abort();
  validation.resolve();
  await save;
  expect(settings.markLocalSetupCompleted).not.toHaveBeenCalled();
});

it("does not retire a pending launch when saving unchanged Comfy settings", async () => {
  const controller = new AbortController();
  const launch = deferred<void>();
  mocks.launch.mockReturnValueOnce(launch.promise);
  const commitComfyConfiguration = vi.fn(() => {
    throw new Error("Unexpected configuration commit");
  });
  registerComfyHandlers(
    settings as unknown as LibrarySettings,
    async () => {},
    {
      captureInferenceProfile: () => controller.signal,
      commitComfyConfiguration
    }
  );
  const pending = invoke(IPC_CHANNELS.comfyLaunch);
  await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
  await expect(
    invoke(IPC_CHANNELS.comfySave, {
      endpoint: "http://localhost:8188",
      vlmBackend: "qwen3-vl-2b-gguf",
      scriptTextModel: "qwen38-27b-q5"
    })
  ).resolves.toMatchObject({ available: true });
  launch.resolve();
  await expect(pending).resolves.toBeUndefined();
  expect(commitComfyConfiguration).not.toHaveBeenCalled();
  expect(settings.saveComfyConfiguration).not.toHaveBeenCalled();
});

it("keeps Comfy metadata available when the sender has no active account profile", async () => {
  const policy = vi.fn(async () => {});
  const capture = vi.fn(() => {
    throw new Error("Sender retired");
  });
  registerOwnedComfy(policy, capture);
  await expect(invoke(IPC_CHANNELS.comfyGet)).resolves.toMatchObject({
    endpoint: "http://localhost:8188"
  });
  expect(capture).not.toHaveBeenCalled();
  await expect(invoke(IPC_CHANNELS.comfyCheck)).rejects.toThrow(
    "Sender retired"
  );
  expect(policy).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
