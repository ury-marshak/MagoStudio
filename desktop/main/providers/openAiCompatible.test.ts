import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateOpenAiCompatible,
  probeOpenAiCompatible
} from "./openAiCompatible";

const config = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "example/vision",
  keychainAccount: "test"
};
const request = {
  systemPrompt: "Describe what you see",
  userPrompt: "Caption",
  maxTokens: 512
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider", () => {
  it("sends ordered inline images and disables OpenRouter fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        model: config.model,
        choices: [{ finish_reason: "stop", message: { content: " Caption " } }]
      })
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      generateOpenAiCompatible(
        config,
        "key"
      )({
        ...request,
        images: [Buffer.from("one"), Buffer.from("two")]
      })
    ).resolves.toEqual({ text: "Caption", model: config.model });
    const [[url, options]] = fetch.mock.calls;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(options).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer key" },
      redirect: "error",
      signal: expect.any(AbortSignal)
    });
    const body = options?.body;
    if (typeof body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(body)).toEqual({
      model: config.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: request.userPrompt },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,b25l" }
            },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,dHdv" }
            }
          ]
        }
      ],
      max_completion_tokens: 512,
      stream: false,
      provider: { allow_fallbacks: false, require_parameters: true }
    });
  });

  it("surfaces a provider error without replaying or exposing its body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("sensitive provider diagnostic", { status: 429 })
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      generateOpenAiCompatible(config, "key")(request)
    ).rejects.toThrow(/^External provider returned HTTP 429$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight request when the caller cancels", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason)
          );
        })
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = generateOpenAiCompatible(
      config,
      "key"
    )({
      ...request,
      signal: controller.signal
    });
    const result = expect(pending).rejects.toThrow(
      "External provider request cancelled"
    );
    controller.abort();
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated completions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        Response.json({
          model: config.model,
          choices: [
            { finish_reason: "length", message: { content: "Partial" } }
          ]
        })
      )
    );
    await expect(
      generateOpenAiCompatible(config, "key")(request)
    ).rejects.toThrow("incomplete or invalid");
  });

  it("probes the model list without generating and checks OpenRouter vision capability", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        data: [
          { id: config.model, architecture: { input_modalities: ["text"] } }
        ]
      })
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      probeOpenAiCompatible(config, "key", "vision")
    ).rejects.toThrow("image input support");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ method: "GET", body: undefined })
    );
  });

  it("checks the key separately from OpenRouter's public catalog", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: config.model, architecture: { input_modalities: ["image"] } }
          ]
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      probeOpenAiCompatible(config, "expired", "vision")
    ).rejects.toThrow("HTTP 401");
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://openrouter.ai/api/v1/key",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer expired" },
        body: undefined
      })
    );
  });
});
