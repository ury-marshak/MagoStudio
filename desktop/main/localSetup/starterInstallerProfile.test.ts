import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { inspect, prepareCopy } = vi.hoisted(() => ({
  inspect: vi.fn(),
  prepareCopy: vi.fn()
}));
vi.mock("./inspectLocalModelGroupsForInstall", () => ({
  inspectLocalModelGroupsForInstall: inspect
}));
vi.mock("./copyModelsToRunningComfy", () => ({
  copyModelsToRunningComfy: prepareCopy
}));

import { ALWAYS_INSTALLED_MODEL_GROUP_IDS } from "../../shared/localModelGroups";
import { COMFY_STARTER_BUNDLE } from "../../shared/localModelManifest";

import { resolveStarterEnginePaths } from "./resolveStarterEnginePaths";
import { deferred } from "./setupTestUtils";
import { StarterInstaller } from "./starterInstaller";

let directory: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const settings = {
  getLocalModelsRoot: vi.fn(async () => directory),
  getSelectedModelGroupVariants: vi.fn(async () => ({})),
  getInstalledModelGroups: vi.fn(async () => ({})),
  recordInstalledModelGroup: vi.fn(async () => {}),
  setSelectedModelGroupVariant: vi.fn(async () => {}),
  getComfyEndpoint: vi.fn(async () => "http://127.0.0.1:8188"),
  hasCompletedLocalSetup: vi.fn(async () => false),
  markLocalSetupCompleted: vi.fn(async () => {}),
  setVlmBackend: vi.fn(async () => {})
};
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected live transport");
    })
  );
  directory = await mkdtemp(path.join(tmpdir(), "mago-installer-profile-"));
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  Object.defineProperty(process, "platform", originalPlatform);
  await rm(directory, { recursive: true, force: true });
});

it("retires preflight without waiting for its pending storage settings read", async () => {
  const root = deferred<string>();
  settings.getLocalModelsRoot.mockReturnValueOnce(root.promise);
  const profile = new AbortController();
  const installer = new StarterInstaller(settings);
  const start = installer.start(undefined, profile.signal);
  await vi.waitFor(() =>
    expect(settings.getLocalModelsRoot).toHaveBeenCalledOnce()
  );
  profile.abort();
  await installer.drainRetired();
  await expect(start).resolves.toMatchObject({ phase: "paused" });
  root.resolve(directory);
  await Promise.resolve();
  expect(inspect).not.toHaveBeenCalled();
  expect(settings.getInstalledModelGroups).not.toHaveBeenCalled();
});

it.each([true, false])(
  "ignores a late copy dialog answer (%s) and keeps the installed file",
  async (answer) => {
    const paths = resolveStarterEnginePaths(directory);
    const file = path.join(paths.comfyDirectory, "model.bin");
    const content = "model bytes";
    await mkdir(paths.comfyDirectory, { recursive: true });
    await mkdir(path.dirname(paths.embeddedPython), { recursive: true });
    await mkdir(paths.cache, { recursive: true });
    await writeFile(paths.embeddedPython, "fixture");
    await writeFile(path.join(paths.comfyDirectory, "main.py"), "fixture");
    await writeFile(
      paths.engineMarker,
      JSON.stringify({ sha256: COMFY_STARTER_BUNDLE.sha256 })
    );
    await writeFile(file, content);
    const item = {
      kind: "model-file",
      name: "model.bin",
      absolutePath: file,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      downloadUrl: "https://non-network-fixture.invalid"
    };
    inspect.mockResolvedValueOnce({
      groups: [
        {
          groupId: ALWAYS_INSTALLED_MODEL_GROUP_IDS[0],
          items: [item],
          missingItems: [item]
        }
      ],
      hardwareVariantGroupIdsPickedForInstall: []
    });
    const copy = Object.assign(vi.fn(), {
      comfyRoot: path.join(directory, "separate-comfy")
    });
    prepareCopy.mockResolvedValueOnce(copy);
    const approval = deferred<boolean>();
    const confirmModelCopy = vi.fn(() => approval.promise);
    const profile = new AbortController();
    const installer = new StarterInstaller(settings, { confirmModelCopy });
    await installer.start(undefined, profile.signal);
    await vi.waitFor(() => expect(confirmModelCopy).toHaveBeenCalledOnce());
    profile.abort();
    await installer.drainRetired();
    expect(installer.status().phase).toBe("paused");
    approval.resolve(answer);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(copy).not.toHaveBeenCalled();
    expect(settings.setVlmBackend).not.toHaveBeenCalled();
    expect(settings.markLocalSetupCompleted).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(content);
  }
);
