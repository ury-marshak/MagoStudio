import { describe, expect, it, vi } from "vitest";

import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

describe("backendApiClient credential barrier", () => {
  it("lets the UI initialize while holding cloud requests until the API key arrives", async () => {
    vi.resetModules();
    const { backendApiClient, initializeBackendApiClient, setApiKey } =
      await import("./backend-api-client");
    const getToken = vi.fn().mockResolvedValue("clerk-token");
    initializeBackendApiClient(getToken, { waitForApiKey: true });

    let adapterCalled = false;
    const request = backendApiClient.get("/projects", {
      adapter: async (config) => {
        adapterCalled = true;
        return {
          data: {},
          status: 200,
          statusText: "OK",
          headers: {},
          config
        };
      }
    });
    await Promise.resolve();
    expect(adapterCalled).toBe(false);

    setApiKey("local-api-key");
    const response = await request;

    expect(adapterCalled).toBe(true);
    expect(response.config.headers.Authorization).toBe("Bearer clerk-token");
    expect(response.config.headers["X-API-Key"]).toBe("local-api-key");
  });

  it.each(["key barrier", "token lookup"] as const)(
    "drops a mutation still waiting for the %s after a library switch",
    async (stage) => {
      vi.resetModules();
      const { backendApiClient, initializeBackendApiClient, setApiKey } =
        await import("./backend-api-client");
      let releaseToken!: () => void;
      const token = new Promise<string>((resolve) => {
        releaseToken = () => resolve("fixture-token");
      });
      const getToken = vi.fn(() => token);
      const waitForApiKey = stage === "key barrier";
      initializeBackendApiClient(getToken, { waitForApiKey });
      const adapter = vi.fn(async (config) => ({
        data: {},
        status: 200,
        statusText: "OK",
        headers: {},
        config
      }));
      const origin = rendererLibrary.capture();
      const pending = runRendererLibraryRequest(origin, (signal) =>
        backendApiClient.put("/projects/reused", {}, { signal, adapter })
      );
      const rejected = expect(pending).rejects.toMatchObject({
        name: "AbortError"
      });
      if (waitForApiKey) {
        // Let the real interceptor reach its unresolved key barrier.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(getToken).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(getToken).toHaveBeenCalledOnce());
      }
      await rendererLibrary.suspend();
      rendererLibrary.reset();
      setApiKey("fixture-key");
      releaseToken();
      await rejected;
      expect(getToken).toHaveBeenCalledTimes(waitForApiKey ? 0 : 1);
      expect(adapter).not.toHaveBeenCalled();
      await runRendererLibraryRequest(rendererLibrary.capture(), (signal) =>
        backendApiClient.put("/projects/reused", {}, { signal, adapter })
      );
      expect(adapter).toHaveBeenCalledOnce();
    }
  );
});
