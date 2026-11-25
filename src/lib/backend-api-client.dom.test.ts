import type { AxiosAdapter } from "axios";
import { afterEach, expect, it, vi } from "vitest";

import type { MagoDesktopApi } from "../../desktop/shared/contracts";

const mode = (value: string | undefined) => {
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { account: { mode: value } } as unknown as MagoDesktopApi
  });
};
const adapter = () =>
  vi.fn<AxiosAdapter>(async (config) => ({
    config,
    data: {},
    status: 200,
    statusText: "OK",
    headers: {}
  }));
afterEach(() => {
  Reflect.deleteProperty(window, "mago");
  vi.restoreAllMocks();
});

it.each(["offline", "unchosen", undefined, "invalid"])(
  "blocks backend calls without a cloud provider mounted in %s desktop mode",
  async (choice) => {
    vi.resetModules();
    mode(choice);
    const { backendApiClient } = await import("./backend-api-client");
    const transport = adapter();
    await expect(
      backendApiClient.get("/projects", { adapter: transport })
    ).rejects.toThrow("explicitly selected cloud account");
    await expect(
      backendApiClient.post(
        "https://backend.invalid/auth",
        {},
        { adapter: transport }
      )
    ).rejects.toThrow("explicitly selected cloud account");
    expect(transport).not.toHaveBeenCalled();
  }
);

it("refuses account-free calls before token lookup or an unresolved credential barrier", async () => {
  vi.resetModules();
  mode("offline");
  const { backendApiClient, initializeBackendApiClient } =
    await import("./backend-api-client");
  const token = vi.fn(async () => "fixture-token");
  initializeBackendApiClient(token, { waitForApiKey: true });
  const transport = adapter();
  await expect(
    backendApiClient.get("/projects", { adapter: transport })
  ).rejects.toThrow("explicitly selected cloud account");
  expect(token).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it.each(["cloud", "web"])(
  "preserves deliberate %s requests and credential headers",
  async (choice) => {
    vi.resetModules();
    if (choice === "cloud") mode(choice);
    else Reflect.deleteProperty(window, "mago");
    const { backendApiClient, initializeBackendApiClient, setApiKey } =
      await import("./backend-api-client");
    const token = vi.fn(async () => "fixture-token");
    initializeBackendApiClient(token, { waitForApiKey: true });
    const transport = adapter();
    const pending = backendApiClient.get("/projects", { adapter: transport });
    await Promise.resolve();
    expect(transport).not.toHaveBeenCalled();
    setApiKey("fixture-api-key");
    const response = await pending;
    expect(transport).toHaveBeenCalledOnce();
    expect(response.config.headers.Authorization).toBe("Bearer fixture-token");
    expect(response.config.headers["X-API-Key"]).toBe("fixture-api-key");
  }
);

it("rechecks the account after a delayed API key without reading a token", async () => {
  vi.resetModules();
  mode("cloud");
  const { backendApiClient, initializeBackendApiClient, setApiKey } =
    await import("./backend-api-client");
  const token = vi.fn(async () => "fixture-token");
  initializeBackendApiClient(token, { waitForApiKey: true });
  const transport = adapter();
  const pending = backendApiClient.get("/projects", { adapter: transport });
  const refused = expect(pending).rejects.toThrow(
    "explicitly selected cloud account"
  );
  await Promise.resolve();
  mode("offline");
  setApiKey("fixture-key");
  await refused;
  expect(token).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it("rechecks the account after a delayed token before transport dispatch", async () => {
  vi.resetModules();
  mode("cloud");
  const { backendApiClient, initializeBackendApiClient } =
    await import("./backend-api-client");
  let finish!: (value: string) => void;
  const token = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  initializeBackendApiClient(token);
  const transport = adapter();
  const pending = backendApiClient.get("/projects", { adapter: transport });
  const refused = expect(pending).rejects.toThrow(
    "explicitly selected cloud account"
  );
  await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
  mode("offline");
  finish("fixture-token");
  await refused;
  expect(transport).not.toHaveBeenCalled();
});

const retireableAccount = () => {
  let retire: (() => void) | undefined;
  const account = {
    mode: "cloud",
    isCurrent: vi.fn(() => true),
    onRetired: (callback: () => void) => {
      retire = callback;
      return () => {
        retire = undefined;
      };
    }
  };
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { account }
  });
  return () => retire?.();
};

it("retires an issued backend request without delivering its late unauthorized result", async () => {
  vi.resetModules();
  const retire = retireableAccount();
  const { backendApiClient, registerUnauthorizedHandler } =
    await import("./backend-api-client");
  const { AxiosError } = await import("axios");
  const unauthorized = vi.fn();
  registerUnauthorizedHandler(unauthorized);
  let finish!: () => void;
  const transport = vi.fn<AxiosAdapter>(
    (config) =>
      new Promise((_resolve, reject) => {
        finish = () =>
          reject(
            new AxiosError("fixture error", undefined, config, undefined, {
              config,
              data: null,
              status: 401,
              statusText: "Unauthorized",
              headers: {}
            })
          );
      })
  );
  const pending = expect(
    backendApiClient.get("/projects", { adapter: transport })
  ).rejects.toMatchObject({ code: "ERR_CANCELED" });
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  const signal = transport.mock.calls[0][0].signal;
  retire();
  expect(signal?.aborted).toBe(true);
  finish();
  await pending;
  expect(unauthorized).not.toHaveBeenCalled();
});

it("ends a credential wait on retirement even when the SDK never settles", async () => {
  vi.resetModules();
  const retire = retireableAccount();
  const { backendApiClient, initializeBackendApiClient } =
    await import("./backend-api-client");
  const token = vi.fn(() => new Promise<string>(() => {}));
  initializeBackendApiClient(token);
  const transport = adapter();
  const pending = expect(
    backendApiClient.get("/projects", { adapter: transport })
  ).rejects.toMatchObject({ code: "ERR_CANCELED" });
  await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
  retire();
  await pending;
  expect(transport).not.toHaveBeenCalled();
});
