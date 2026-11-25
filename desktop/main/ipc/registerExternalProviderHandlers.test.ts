import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared/contracts";
import { createExternalProviderSettings } from "../providers/externalProviderSettings";

import { registerExternalProviderHandlers } from "./registerExternalProviderHandlers";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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

beforeEach(() => {
  vi.resetAllMocks();
});

it("checks the saved fal key locally without returning it or probing a provider", async () => {
  const settings = createExternalProviderSettings(() => "/unused");
  vi.spyOn(settings, "getFal").mockResolvedValue({
    keychainAccount: "fal",
    revision: "fixture-revision"
  });
  mocks.readExternalProviderKey.mockResolvedValue("mock-fal-secret");
  registerExternalProviderHandlers(settings);

  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.externalProvidersCheck
  )?.[1];
  const event = {};
  await expect(handler(event, "fal")).resolves.toBeUndefined();
  expect(mocks.requireTrustedSender).toHaveBeenCalledExactlyOnceWith(event);
  expect(mocks.readExternalProviderKey).toHaveBeenCalledExactlyOnceWith(
    "fal",
    expect.objectContaining({ aborted: false })
  );
  expect(mocks.probeOpenAiCompatible).not.toHaveBeenCalled();
});

it("does not dispatch a retired provider check after saving on the same window", async () => {
  mocks.readExternalProviderKey.mockResolvedValue("mock-not-a-credential");
  mocks.probeOpenAiCompatible.mockResolvedValue(undefined);
  const dir = await mkdtemp(path.join(tmpdir(), "mago-provider-transition-"));
  try {
    const settings = createExternalProviderSettings(() => dir);
    registerExternalProviderHandlers(settings);
    const handler = (channel: string) =>
      mocks.handle.mock.calls.find(
        ([registered]) => registered === channel
      )?.[1];
    const save = handler(IPC_CHANNELS.externalProvidersSave);
    const check = handler(IPC_CHANNELS.externalProvidersCheck);
    const event = { sender: { id: 1 } };
    const providerA = {
      baseUrl: "https://provider-a.example/v1",
      model: "model-a",
      keychainAccount: "mock-a"
    };
    const providerB = {
      baseUrl: "https://provider-b.example/v1",
      model: "model-b",
      keychainAccount: "mock-b"
    };
    await save(event, "vision", providerA);

    const readingA = deferred<void>();
    const keyA = deferred<string>();
    mocks.readExternalProviderKey.mockImplementationOnce(() => {
      readingA.resolve();
      return keyA.promise;
    });
    const result = check(event, "vision").then(
      () => ({ published: true }),
      (error: unknown) => ({ published: false, error })
    );
    await readingA.promise;
    await save(event, "vision", providerB);
    keyA.resolve("mock-not-a-credential");

    const outcome = await result;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({
      dispatched: mocks.probeOpenAiCompatible.mock.calls.length,
      published: outcome.published
    }).toEqual({ dispatched: 0, published: false });
    expect(outcome).toMatchObject({ error: { name: "AbortError" } });
    await expect(settings.get("vision")).resolves.toEqual(providerB);
    await expect(check(event, "vision")).resolves.toBeUndefined();
    expect(mocks.probeOpenAiCompatible).toHaveBeenCalledExactlyOnceWith(
      providerB,
      expect.any(String),
      "vision",
      expect.objectContaining({ aborted: false })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retires a pending fal key check when the same window saves a new account", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mago-fal-transition-"));
  try {
    const settings = createExternalProviderSettings(() => dir);
    registerExternalProviderHandlers(settings);
    const handler = (channel: string) =>
      mocks.handle.mock.calls.find(
        ([registered]) => registered === channel
      )?.[1];
    const save = handler(IPC_CHANNELS.externalProvidersSave);
    const check = handler(IPC_CHANNELS.externalProvidersCheck);
    const event = { sender: { id: 1 } };
    await save(event, "fal", { keychainAccount: "mock-fal-a" });

    const readingA = deferred<void>();
    const keyA = deferred<string>();
    mocks.readExternalProviderKey.mockImplementationOnce(() => {
      readingA.resolve();
      return keyA.promise;
    });
    const outcome = check(event, "fal").then(
      () => ({ published: true }),
      (error: unknown) => ({ published: false, error })
    );
    await readingA.promise;
    await save(event, "fal", { keychainAccount: "mock-fal-b" });
    keyA.resolve("mock-not-a-credential");
    await expect(outcome).resolves.toMatchObject({
      published: false,
      error: { name: "AbortError" }
    });
    expect(mocks.readExternalProviderKey).toHaveBeenNthCalledWith(
      1,
      "mock-fal-a",
      expect.objectContaining({ aborted: true })
    );

    mocks.readExternalProviderKey.mockResolvedValue("mock-not-a-credential");
    await expect(check(event, "fal")).resolves.toBeUndefined();
    expect(mocks.readExternalProviderKey).toHaveBeenNthCalledWith(
      2,
      "mock-fal-b",
      expect.objectContaining({ aborted: false })
    );
    expect(mocks.probeOpenAiCompatible).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects a queued provider save when its sender retires before the shared commit", async () => {
  const gate = deferred<void>();
  const account = new AbortController();
  const dir = await mkdtemp(path.join(tmpdir(), "mago-provider-transition-"));
  try {
    const settings = createExternalProviderSettings(() => dir, {
      serializeWrite: (operation) => gate.promise.then(operation)
    });
    const captureAccountProfile = vi.fn(() => account.signal);
    registerExternalProviderHandlers(settings, { captureAccountProfile });
    const save = mocks.handle.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.externalProvidersSave
    )?.[1];
    const sender = { id: 1 };
    const result = save({ sender }, "text", {
      baseUrl: "https://provider.example/v1",
      model: "model",
      keychainAccount: "mock-account"
    });
    expect(() => settings.captureInferenceProfile()).toThrow();
    account.abort();
    gate.resolve();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(captureAccountProfile).toHaveBeenCalledExactlyOnceWith(sender);
    await expect(settings.get("text")).resolves.toBeNull();
    expect(settings.captureInferenceProfile().aborted).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
