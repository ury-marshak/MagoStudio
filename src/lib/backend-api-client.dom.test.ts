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
