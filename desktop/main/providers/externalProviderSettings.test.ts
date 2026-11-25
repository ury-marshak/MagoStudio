import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createExternalProviderSettings,
  resolveProviderStartupMode
} from "./externalProviderSettings";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mago-providers-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const writeSettings = (value: unknown) =>
  writeFile(
    path.join(directory, "external-providers.json"),
    JSON.stringify(value)
  );

const vision = {
  baseUrl: "https://openrouter.ai/api/v1/",
  model: "example/vision",
  keychainAccount: "openrouter"
};

describe("external provider settings", () => {
  it("reads text and vision independently", async () => {
    const settings = createExternalProviderSettings(() => directory);
    await expect(settings.get("vision")).resolves.toBeNull();

    await writeSettings({ vision });
    await expect(settings.get("text")).resolves.toBeNull();
    await expect(settings.get("vision")).resolves.toEqual({
      ...vision,
      baseUrl: "https://openrouter.ai/api/v1"
    });
  });

  it("serializes capability updates and removes only the requested entry", async () => {
    const settings = createExternalProviderSettings(() => directory);
    const text = { ...vision, model: "example/text" };
    await Promise.all([
      settings.save("text", text),
      settings.save("vision", vision)
    ]);

    await expect(settings.get("text")).resolves.toMatchObject({
      model: text.model
    });
    await expect(settings.get("vision")).resolves.toMatchObject({
      model: vision.model
    });
    await settings.save("text", null);
    await expect(settings.get("text")).resolves.toBeNull();
    await expect(settings.get("vision")).resolves.toMatchObject({
      model: vision.model
    });
  });

  it("keeps inference admission closed across queued commits", async () => {
    const firstCommit = deferred<void>();
    const secondCommit = deferred<void>();
    const gates = [firstCommit.promise, secondCommit.promise];
    let pending: Promise<unknown> = Promise.resolve();
    const settings = createExternalProviderSettings(() => directory, {
      serializeWrite: (operation) => {
        const gate = gates.shift();
        const write = pending.then(async () => {
          await gate;
          return operation();
        });
        pending = write.catch(() => {});
        return write;
      }
    });
    const original = settings.captureInferenceProfile();
    const first = settings.save("vision", vision);
    const second = settings.save("text", vision);
    expect(original.aborted).toBe(true);
    expect(() => settings.captureInferenceProfile()).toThrow();
    firstCommit.resolve();
    await first;
    expect(() => settings.captureInferenceProfile()).toThrow();
    secondCommit.resolve();
    await second;
    expect(settings.captureInferenceProfile().aborted).toBe(false);
    expect(original.aborted).toBe(true);
    await expect(settings.get("vision")).resolves.toMatchObject({
      model: vision.model
    });
    await expect(settings.get("text")).resolves.toMatchObject({
      model: vision.model
    });
  });

  it("reopens the persisted profile on failed rename without leaking a temporary file", async () => {
    const settings = createExternalProviderSettings(() => directory);
    await settings.save("vision", vision);
    const original = settings.captureInferenceProfile();
    vi.mocked(rename).mockRejectedValueOnce(
      new Error("Fixture persistence failure")
    );
    await expect(
      settings.save("vision", { ...vision, model: "not persisted" })
    ).rejects.toThrow("Could not save external provider settings");
    expect(original.aborted).toBe(true);
    expect(settings.captureInferenceProfile().aborted).toBe(false);
    await expect(settings.getForInference("vision")).resolves.toMatchObject({
      model: vision.model
    });
    await expect(readdir(directory)).resolves.toEqual([
      "external-providers.json"
    ]);
  });

  it("stores fal defaults and the Keychain account alongside text and vision settings", async () => {
    const settings = createExternalProviderSettings(() => directory);
    const fal = {
      keychainAccount: "fal",
      referenceImageModel: "fal_minimax_h3_image",
      shotProvider: "local-comfy",
      generationSettings: {
        minimax_h3_max: { resolution: "480P", aspect_ratio: "9:16", seed: 7 },
        fal_minimax_h3_image: { megapixels: "4" }
      }
    };
    await Promise.all([
      settings.save("text", vision),
      settings.save("vision", vision),
      settings.saveFal(fal)
    ]);

    await expect(
      settings.saveFal({ ...fal, apiKey: "test-secret" })
    ).rejects.toThrow("Invalid fal provider settings");
    await expect(
      settings.saveFal({ ...fal, referenceImageModel: "unknown" })
    ).rejects.toThrow("Invalid fal provider settings");
    await expect(
      settings.saveFal({
        ...fal,
        generationSettings: { fal_minimax_h3_image: { resolution: "4K" } }
      })
    ).rejects.toThrow("Invalid fal provider settings");
    const confirmed = await settings.getFal();
    expect(confirmed).toEqual({ ...fal, revision: expect.any(String) });
    await expect(settings.getFal()).resolves.toEqual(confirmed);
    const replacement = await settings.saveFal(fal);
    expect(replacement?.revision).not.toBe(confirmed?.revision);
    await expect(settings.getFal()).resolves.toEqual(replacement);
    const persisted = await readFile(
      path.join(directory, "external-providers.json"),
      "utf8"
    );
    expect(JSON.parse(persisted).fal).toEqual(fal);
    expect(persisted).not.toContain("test-secret");

    await settings.saveFal(null);
    await expect(settings.getFal()).resolves.toBeNull();
    await expect(settings.get("text")).resolves.toMatchObject({
      model: vision.model
    });
    await expect(settings.get("vision")).resolves.toMatchObject({
      model: vision.model
    });
  });

  it("retires the fal revision when the on-disk defaults are edited directly", async () => {
    const settings = createExternalProviderSettings(() => directory);
    const fal = { keychainAccount: "fal" };
    const before = await settings.saveFal(fal);
    await writeSettings({
      fal: {
        ...fal,
        generationSettings: { minimax_h3_max: { resolution: "480P" } }
      }
    });
    const after = await settings.getFal();
    expect(after?.keychainAccount).toBe(before?.keychainAccount);
    expect(after?.revision).not.toBe(before?.revision);
  });

  it("rejects a plaintext credential without altering the saved configuration", async () => {
    const settings = createExternalProviderSettings(() => directory);
    await settings.save("vision", vision);
    const profile = settings.captureInferenceProfile();

    await expect(
      settings.save("vision", { ...vision, apiKey: "test-secret" })
    ).rejects.toThrow("Invalid external vision provider settings");
    expect(settings.captureInferenceProfile()).toBe(profile);
    expect(profile.aborted).toBe(false);
    await expect(settings.get("vision")).resolves.toMatchObject({
      model: vision.model
    });
    await expect(settings.save("text", vision)).resolves.toMatchObject({
      model: vision.model
    });
  });

  it("preserves a malformed file so it can be repaired manually", async () => {
    const file = path.join(directory, "external-providers.json");
    await writeFile(file, "{");
    const settings = createExternalProviderSettings(() => directory);

    await expect(settings.save("text", vision)).rejects.toThrow("invalid JSON");
    await expect(readFile(file, "utf8")).resolves.toBe("{");
  });

  it.each([
    { ...vision, apiKey: "plaintext" },
    { ...vision, baseUrl: "http://example.com/v1" },
    { ...vision, baseUrl: "https://example.com/v1?api_key=plaintext" },
    { ...vision, model: "openrouter/auto" },
    null
  ])("rejects an invalid configured provider", async (entry) => {
    await writeSettings({ vision: entry });
    await expect(
      createExternalProviderSettings(() => directory).get("vision")
    ).rejects.toThrow();
  });
});

describe("external provider startup mode", () => {
  const settings = createExternalProviderSettings(() => directory);

  it.each(["text", "vision"] as const)(
    "opens the local editor with just a %s configuration",
    async (capability) => {
      await writeSettings({ [capability]: vision });
      await expect(resolveProviderStartupMode(null, settings)).resolves.toBe(
        "offline"
      );
    }
  );

  it("opens the local editor with just a fal credential reference", async () => {
    await settings.saveFal({ keychainAccount: "fal" });
    await expect(resolveProviderStartupMode(null, settings)).resolves.toBe(
      "offline"
    );
  });

  it("honors a saved account mode when external providers are configured", async () => {
    await writeSettings({ text: vision });
    await expect(resolveProviderStartupMode("cloud", settings)).resolves.toBe(
      "cloud"
    );
    await expect(resolveProviderStartupMode("offline", settings)).resolves.toBe(
      "offline"
    );
  });

  it("keeps first-launch choices available with missing or malformed settings", async () => {
    await expect(resolveProviderStartupMode(null, settings)).resolves.toBe(
      "unchosen"
    );
    await writeFile(path.join(directory, "external-providers.json"), "{");
    await expect(resolveProviderStartupMode(null, settings)).resolves.toBe(
      "unchosen"
    );
  });

  it("opens the editor when one configured capability is valid and another is invalid", async () => {
    await writeSettings({ text: null, vision });
    await expect(resolveProviderStartupMode(null, settings)).resolves.toBe(
      "offline"
    );
  });
});
