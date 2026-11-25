import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { externalReasoningEfforts } from "../../shared/contracts";
import type {
  ExternalModelCapability,
  ExternalModelConfig,
  FalProviderConfig,
  FalProviderMetadata,
  MagoAppMode
} from "../../shared/contracts";
import { falGenerationDefaultsSchema } from "../../shared/falGenerationSettings";
import { FAL_SHEET_MODELS } from "../../shared/falSheetModel";
import { FAL_SHOT_PROVIDER } from "../../shared/falShotModel";

import { InferenceUnavailableError } from "./inferenceUnavailableError";
import { ProfileLifetime } from "./profileLifetime";

export type {
  ExternalModelCapability,
  ExternalModelConfig
} from "../../shared/contracts";

const run = promisify(execFile);
const keychainService = "MagoStudio.ExternalProvider";

const keychainAccountSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const falSchema = z.strictObject({
  keychainAccount: keychainAccountSchema,
  generationSettings: falGenerationDefaultsSchema.optional(),
  referenceImageModel: z.enum(FAL_SHEET_MODELS).optional(),
  storyboardImageModel: z.enum(FAL_SHEET_MODELS).optional(),
  shotProvider: z.enum([FAL_SHOT_PROVIDER, "local-comfy"]).optional()
});

const parseFalConfig = (value: unknown): FalProviderConfig => {
  const config = falSchema.safeParse(value);
  if (!config.success) throw new Error("Invalid fal provider settings");
  return config.data;
};

const providerSchema = z.strictObject({
  baseUrl: z.string().url(),
  model: z.string().trim().min(1),
  reasoningEffort: z.enum(externalReasoningEfforts).optional(),
  keychainAccount: keychainAccountSchema
});

const parseConfig = (
  capability: ExternalModelCapability,
  value: unknown
): ExternalModelConfig => {
  const config = providerSchema.safeParse(value);
  if (!config.success)
    throw new Error(`Invalid external ${capability} provider settings`);
  const url = new URL(config.data.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "External providers require an HTTPS base URL without credentials, a query, or a fragment"
    );
  if (
    url.hostname === "openrouter.ai" &&
    config.data.model.startsWith("openrouter/")
  )
    throw new Error("Choose a specific OpenRouter model");
  if (config.data.reasoningEffort && url.hostname !== "openrouter.ai")
    throw new Error("Reasoning effort is currently supported for OpenRouter");
  return { ...config.data, baseUrl: url.href.replace(/\/+$/, "") };
};

const readSettings = async (file: string): Promise<Record<string, unknown>> => {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return {};
    throw new Error("Could not read external provider settings");
  }
  let settings: unknown;
  try {
    settings = JSON.parse(contents);
  } catch {
    throw new Error("External provider settings contain invalid JSON");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("External provider settings must be a JSON object");
  if (
    Object.keys(settings).some(
      (key) => key !== "text" && key !== "vision" && key !== "fal"
    )
  )
    throw new Error(
      "External provider settings support text, vision, and fal entries"
    );
  return settings as Record<string, unknown>;
};

type ProviderEntry = ExternalModelCapability | "fal";

type SerializeWrite = <T>(operation: () => Promise<T>) => Promise<T>;

export const createExternalProviderSettings = (
  userData: () => string,
  {
    serializeWrite,
    drainRetiredInference
  }: {
    serializeWrite?: SerializeWrite;
    drainRetiredInference?: () => Promise<void>;
  } = {}
) => {
  const settingsPath = () => path.join(userData(), "external-providers.json");
  let pendingWrite: Promise<unknown> = Promise.resolve();
  const enqueue: SerializeWrite =
    serializeWrite ??
    ((operation) => {
      const write = pendingWrite.then(operation);
      pendingWrite = write.catch(() => {});
      return write;
    });
  const inferenceProfile = new ProfileLifetime();
  let queuedWrites = 0;
  let falSaveEpoch = randomUUID();
  // A same-value save retires consent; a direct edit of the metadata file does
  // too when it changes the effective configuration. Neither requires Keychain.
  const falMetadata = (
    config: FalProviderConfig | null,
    saveEpoch: string
  ): FalProviderMetadata | null =>
    config && {
      ...config,
      revision: createHash("sha256")
        .update(JSON.stringify([saveEpoch, config]))
        .digest("hex")
    };

  const get = async <Config>(
    entry: ProviderEntry,
    parse: (value: unknown) => Config
  ): Promise<Config | null> => {
    const settings = await readSettings(settingsPath());
    return Object.hasOwn(settings, entry) ? parse(settings[entry]) : null;
  };

  const save = async <Config>(
    entry: ProviderEntry,
    value: unknown,
    parse: (value: unknown) => Config,
    origin?: AbortSignal,
    onPersisted?: () => void
  ): Promise<Config | null> => {
    origin?.throwIfAborted();
    const config = value === null ? null : parse(value);
    // Mutating any entry can change whether legacy text/vision is permitted.
    // Close admission synchronously and keep it closed across queued saves.
    queuedWrites += 1;
    inferenceProfile.suspend();
    try {
      return await enqueue(async () => {
        await drainRetiredInference?.();
        origin?.throwIfAborted();
        const file = settingsPath();
        const settings = await readSettings(file);
        origin?.throwIfAborted();
        if (config === null) delete settings[entry];
        else settings[entry] = config;
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", {
            flag: "wx",
            mode: 0o600
          });
          origin?.throwIfAborted();
          await rename(temporary, file);
          onPersisted?.();
        } catch {
          origin?.throwIfAborted();
          throw new Error("Could not save external provider settings");
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
        return config;
      });
    } finally {
      queuedWrites -= 1;
      if (queuedWrites === 0) inferenceProfile.resume();
    }
  };

  return {
    captureInferenceProfile: () => inferenceProfile.capture(),
    get: (capability: ExternalModelCapability) =>
      get(capability, (value) => parseConfig(capability, value)),
    /** A partial external profile is not permission to use legacy inference.
     * Read selection and the omission gate from one metadata snapshot; never
     * inspect credentials, probe models, or treat invalid entries as absent. */
    getForInference: async (capability: ExternalModelCapability) => {
      const settings = await readSettings(settingsPath());
      if (Object.hasOwn(settings, capability))
        return parseConfig(capability, settings[capability]);
      if (Object.keys(settings).length > 0)
        throw new Error(
          `Configure an external ${capability} provider to use this capability. Legacy Mago/ComfyUI inference is disabled while external providers are configured.`
        );
      return null;
    },
    assertLegacyInferenceAvailable: () =>
      inferenceProfile.run(async (signal) => {
        const settings = await readSettings(settingsPath());
        signal.throwIfAborted();
        if (Object.keys(settings).length > 0)
          throw new InferenceUnavailableError(
            "Local inference, supporting effects and model setup are unavailable while external providers are configured. No external adapter is integrated for this operation."
          );
      }),
    save: (
      capability: ExternalModelCapability,
      value: unknown,
      origin?: AbortSignal
    ) =>
      save(
        capability,
        value,
        (entry) => parseConfig(capability, entry),
        origin
      ),
    getFal: () =>
      inferenceProfile.run(async () => {
        const config = await get("fal", parseFalConfig);
        return falMetadata(config, falSaveEpoch);
      }),
    saveFal: async (value: unknown, origin?: AbortSignal) => {
      const saveEpoch = randomUUID();
      const config = await save("fal", value, parseFalConfig, origin, () => {
        falSaveEpoch = saveEpoch;
      });
      return falMetadata(config, saveEpoch);
    }
  };
};

export const resolveProviderStartupMode = async (
  savedMode: Exclude<MagoAppMode, "unchosen"> | null,
  settings: ReturnType<typeof createExternalProviderSettings>
): Promise<MagoAppMode> => {
  if (savedMode) return savedMode;
  const configurations = await Promise.allSettled([
    settings.get("text"),
    settings.get("vision"),
    settings.getFal()
  ]);
  // Configuration is optional at startup. A broken entry must not hide
  // another configured capability or block opening the local editor.
  return configurations.some(
    (result) => result.status === "fulfilled" && result.value !== null
  )
    ? "offline"
    : "unchosen";
};

export const readExternalProviderKey = async (
  account: string,
  signal?: AbortSignal
): Promise<string> => {
  signal?.throwIfAborted();
  if (process.platform !== "darwin")
    throw new Error(
      "External provider credentials currently require macOS Keychain"
    );
  let password: string;
  try {
    const { stdout } = await run(
      "/usr/bin/security",
      ["find-generic-password", "-s", keychainService, "-a", account, "-w"],
      { encoding: "utf8", timeout: 30_000, signal }
    );
    password = stdout.trim();
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Could not read the external provider credential from macOS Keychain"
    );
  }
  signal?.throwIfAborted();
  if (!/^[!-~]+$/.test(password))
    throw new Error("The external provider credential is empty or invalid");
  return password;
};
