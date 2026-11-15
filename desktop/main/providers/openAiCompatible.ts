import { z } from "zod";

import type { VisionGenerator } from "../vlm/visionGenerator";

import type {
  ExternalModelCapability,
  ExternalModelConfig
} from "./externalProviderSettings";

const requestTimeoutMs = 120_000;
const probeTimeoutMs = 15_000;
const maxImages = 4;

const completionSchema = z.object({
  model: z.string().min(1),
  choices: z.tuple([
    z.object({
      finish_reason: z.literal("stop"),
      message: z.object({ content: z.string().trim().min(1) })
    })
  ])
});

const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      architecture: z
        .object({ input_modalities: z.array(z.string()) })
        .optional()
    })
  )
});

const isOpenRouter = (config: ExternalModelConfig): boolean =>
  new URL(config.baseUrl).hostname === "openrouter.ai";

const requestJson = async (
  config: ExternalModelConfig,
  apiKey: string,
  route: string,
  timeoutMs: number,
  body?: unknown,
  callerSignal?: AbortSignal
): Promise<unknown> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([timeout, callerSignal])
    : timeout;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal
    });
  } catch {
    throw new Error(
      callerSignal?.aborted
        ? "External provider request cancelled"
        : timeout.aborted
          ? "External provider request timed out"
          : "Could not reach external provider"
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`External provider returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(
      callerSignal?.aborted
        ? "External provider request cancelled"
        : timeout.aborted
          ? "External provider request timed out"
          : "External provider returned invalid JSON"
    );
  }
};

export const generateOpenAiCompatible =
  (config: ExternalModelConfig, apiKey: string): VisionGenerator =>
  async ({
    systemPrompt,
    userPrompt,
    images,
    maxTokens,
    temperature,
    signal
  }) => {
    if (images && images.length > maxImages)
      throw new Error(
        `External vision requests support up to ${maxImages} images`
      );
    const content = images?.length
      ? [
          { type: "text", text: userPrompt },
          ...images.map((image) => ({
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${image.toString("base64")}`
            }
          }))
        ]
      : userPrompt;
    const response = await requestJson(
      config,
      apiKey,
      "chat/completions",
      requestTimeoutMs,
      {
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content }
        ],
        max_completion_tokens: maxTokens,
        ...(config.reasoningEffort
          ? { reasoning: { effort: config.reasoningEffort } }
          : { temperature }),
        stream: false,
        ...(isOpenRouter(config)
          ? { provider: { allow_fallbacks: false, require_parameters: true } }
          : {})
      },
      signal
    );
    const parsed = completionSchema.safeParse(response);
    if (!parsed.success)
      throw new Error(
        "External provider returned an incomplete or invalid completion"
      );
    return {
      text: parsed.data.choices[0].message.content,
      model: parsed.data.model
    };
  };

export const probeOpenAiCompatible = async (
  config: ExternalModelConfig,
  apiKey: string,
  capability: ExternalModelCapability,
  signal?: AbortSignal
): Promise<void> => {
  const response = modelsSchema.safeParse(
    await requestJson(
      config,
      apiKey,
      "models",
      probeTimeoutMs,
      undefined,
      signal
    )
  );
  if (!response.success)
    throw new Error("External provider returned an invalid model list");
  const model = response.data.data.find(({ id }) => id === config.model);
  if (!model)
    throw new Error(
      "The configured model is missing from the external provider's model list"
    );
  if (
    capability === "vision" &&
    isOpenRouter(config) &&
    !model.architecture?.input_modalities.includes("image")
  )
    throw new Error(
      "The configured OpenRouter model does not list image input support"
    );
  // The OpenRouter model catalog is public, so a successful listing alone
  // does not verify the saved credential.
  if (isOpenRouter(config))
    await requestJson(config, apiKey, "key", probeTimeoutMs, undefined, signal);
};
