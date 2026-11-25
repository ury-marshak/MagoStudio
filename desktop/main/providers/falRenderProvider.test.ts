import { setImmediate } from "node:timers/promises";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FalRenderProvider } from "./falRenderProvider";
import { ProfileIoDrain } from "./profileIoDrain";

const config = { keychainAccount: "fal-test" };
const request = {
  ...config,
  endpoint: "fal-ai/test",
  requestId: "test-request"
};
const fetchMock = vi.fn<typeof fetch>();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

it.each(["refresh", "cancel"] as const)(
  "%s aborts a held Keychain wait and never starts a queue request",
  async (operation) => {
    const controller = new AbortController();
    const started = deferred<void>();
    const held = deferred<string>();
    const readKey = vi.fn((_account: string, _signal?: AbortSignal) => {
      started.resolve();
      return held.promise;
    });
    const provider = new FalRenderProvider(async () => config, readKey);
    const { signal } = controller;
    const pending =
      operation === "refresh"
        ? provider.refresh(request, "image", signal)
        : provider.cancel(request, signal);
    const aborted = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });

    await started.promise;
    expect(readKey).toHaveBeenCalledExactlyOnceWith(
      config.keychainAccount,
      signal
    );
    controller.abort();
    await aborted;
    held.resolve("fixture-key");
    await setImmediate();
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it.each(["submit", "poll", "output", "cancel"] as const)(
  "aborts a held metadata wait for %s without entering Keychain",
  async (operation) => {
    const controller = new AbortController();
    const started = deferred<void>();
    const held = deferred<typeof config>();
    const getConfig = vi.fn((_signal?: AbortSignal) => {
      started.resolve();
      return held.promise;
    });
    const readKey = vi.fn(async () => "fixture-key");
    const provider = new FalRenderProvider(getConfig, readKey);
    const signal = controller.signal;
    const pending =
      operation === "submit"
        ? provider.prepareSubmission(request.endpoint, signal)
        : operation === "poll"
          ? provider.refresh(request, "image", signal)
          : operation === "output"
            ? provider.assertOutputAccess(request, signal)
            : provider.cancel(request, signal);
    const aborted = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });

    await started.promise;
    expect(getConfig).toHaveBeenCalledExactlyOnceWith(controller.signal);
    controller.abort();
    await aborted;
    held.resolve(config);
    await setImmediate();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it.each(["POST", "PUT"] as const)(
  "aborts the storage %s and waits to dispose of its late response body",
  async (method) => {
    const controller = new AbortController();
    const readKey = vi.fn(async () => "fixture-key");
    const provider = new FalRenderProvider(async () => config, readKey);
    const prepared = await provider.prepareSubmission(
      request.endpoint,
      controller.signal
    );
    if (method === "PUT") {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          file_url: "https://v3.fal.media/file.png",
          upload_url: "https://v3.fal.media/upload/file"
        })
      );
    }
    const started = deferred<AbortSignal>();
    const held = deferred<Response>();
    fetchMock.mockImplementationOnce((_url, options) => {
      expect(options?.method).toBe(method);
      started.resolve(options!.signal!);
      return held.promise;
    });
    const disposeStarted = deferred<void>();
    const disposed = deferred<void>();
    const response = new Response(
      new ReadableStream({
        cancel() {
          disposeStarted.resolve();
          return disposed.promise;
        }
      })
    );

    const finished = vi.fn();
    const aborted = expect(
      prepared.upload(new Blob(["image"]), "file.png").finally(finished)
    ).rejects.toMatchObject({ name: "AbortError" });
    const transportSignal = await started.promise;
    controller.abort();
    expect(transportSignal.aborted).toBe(true);
    held.resolve(response);
    await disposeStarted.promise;
    await setImmediate();
    expect(finished).not.toHaveBeenCalled();
    if (method === "POST") disposed.resolve();
    else disposed.reject(new Error("The response stream was already aborted"));
    await aborted;
    expect(fetchMock).toHaveBeenCalledTimes(method === "POST" ? 1 : 2);
  }
);

it("cancels the locked initiation body and drains its cleanup before persistence", async () => {
  const profile = new AbortController();
  const io = new ProfileIoDrain();
  const readPending = deferred<void>();
  const transportCleanup = deferred<void>();
  const canceled = vi.fn(() => transportCleanup.promise);
  let incomplete: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        incomplete = controller;
        controller.enqueue(new TextEncoder().encode('{"file_url":"https://'));
      },
      pull() {
        readPending.resolve();
      },
      cancel() {
        incomplete = undefined;
        return canceled();
      }
    })
  );
  fetchMock.mockResolvedValueOnce(response);
  const provider = new FalRenderProvider(
    async () => config,
    async () => "fixture-key"
  );
  const prepared = await provider.prepareSubmission(
    request.endpoint,
    profile.signal
  );
  const issued = io.run(profile.signal, async () => {
    const image = await prepared.upload(new Blob(["image"]), "image.png");
    await prepared.submit({ image_url: image });
  });
  const aborted = expect(issued).rejects.toMatchObject({ name: "AbortError" });
  const persisted = vi.fn();
  let persistence: Promise<unknown> | undefined;
  try {
    await readPending.promise;
    expect(response.body?.locked).toBe(true);
    profile.abort();
    persistence = io.drainRetired().then(persisted);
    await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce(), {
      timeout: 250
    });
    expect(persisted).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual([
      "POST"
    ]);
  } finally {
    incomplete?.close();
    transportCleanup.resolve();
    await Promise.allSettled([aborted, persistence]);
  }
  await aborted;
  expect(response.body?.locked).toBe(false);
  expect(persisted).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
});
