import { afterEach, describe, expect, it, vi } from "vitest";

import { restartComfy } from "./restartComfy";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const endpoint = "http://127.0.0.1:8188";
const launcherWith = (isLaunchedByMago: boolean) => ({
  isLaunchedProcessRunning: () => isLaunchedByMago,
  restartLaunchedProcess: vi.fn(async () => {}),
  relaunchProcessStartedOutsideMago: vi.fn(async () => {}),
  waitUntilEndpointStopsAnswering: vi.fn(async () => {})
});
const stubComfyManagerReboot = (isRebootAccepted: boolean) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response("", { status: isRebootAccepted ? 200 : 403 })
    )
  );

describe("restartComfy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restarts the process Mago launched", async () => {
    stubComfyManagerReboot(true);
    const launcher = launcherWith(true);

    await restartComfy({ launcher, endpoint });

    expect(launcher.restartLaunchedProcess).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks ComfyUI-Manager to reboot a ComfyUI started outside Mago", async () => {
    stubComfyManagerReboot(true);
    const launcher = launcherWith(false);

    await restartComfy({ launcher, endpoint });

    expect(launcher.relaunchProcessStartedOutsideMago).not.toHaveBeenCalled();
  });

  it("relaunches from the install folder when ComfyUI-Manager accepts but ComfyUI keeps answering", async () => {
    stubComfyManagerReboot(true);
    const launcher = launcherWith(false);
    launcher.waitUntilEndpointStopsAnswering.mockRejectedValue(
      new Error("still answering")
    );

    await restartComfy({ launcher, endpoint });

    expect(launcher.relaunchProcessStartedOutsideMago).toHaveBeenCalledTimes(1);
  });

  it("relaunches from the install folder when ComfyUI-Manager refuses", async () => {
    stubComfyManagerReboot(false);
    const launcher = launcherWith(false);

    await restartComfy({ launcher, endpoint });

    expect(launcher.relaunchProcessStartedOutsideMago).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to relaunch when retirement happens during the Manager shutdown wait", async () => {
    stubComfyManagerReboot(true);
    const controller = new AbortController();
    const launcher = launcherWith(false);
    const shutdown = deferred<void>();
    launcher.waitUntilEndpointStopsAnswering.mockReturnValue(shutdown.promise);
    const restart = restartComfy({
      launcher,
      endpoint,
      signal: controller.signal
    });
    const rejected = expect(restart).rejects.toHaveProperty(
      "name",
      "AbortError"
    );
    await vi.waitFor(() =>
      expect(launcher.waitUntilEndpointStopsAnswering).toHaveBeenCalledOnce()
    );
    controller.abort();
    shutdown.reject(new Error("Still answering"));
    await rejected;
    expect(launcher.relaunchProcessStartedOutsideMago).not.toHaveBeenCalled();
  });

  it("disposes a late Manager response without trying the older reboot route", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const launcher = launcherWith(false);
    const restart = restartComfy({
      launcher,
      endpoint,
      signal: controller.signal
    });
    const rejected = expect(restart).rejects.toHaveProperty(
      "name",
      "AbortError"
    );
    controller.abort();
    const cancel = vi.fn();
    pending.resolve(
      new Response(new ReadableStream({ cancel }), { status: 404 })
    );
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(launcher.relaunchProcessStartedOutsideMago).not.toHaveBeenCalled();
  });
});
