import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  ExternalModelCapability,
  ExternalModelConfig,
  FalProviderConfig,
  MagoAppMode
} from "../../shared/contracts";

export type {
  ExternalModelCapability,
  ExternalModelConfig
} from "../../shared/contracts";

const run = promisify(execFile);
const keychainService = "MagoStudio.ExternalProvider";

const keychainAccountSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const falSchema = z.strictObject({ keychainAccount: keychainAccountSchema });

const parseFalConfig = (value: unknown): FalProviderConfig => {
  const config = falSchema.safeParse(value);
  if (!config.success) throw new Error("Invalid fal provider settings");
  return config.data;
};

const providerSchema = z.strictObject({
  baseUrl: z.string().url(),
  model: z.string().trim().min(1),
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

export const createExternalProviderSettings = (userData: () => string) => {
  const settingsPath = () => path.join(userData(), "external-providers.json");
  let pendingWrite: Promise<unknown> = Promise.resolve();

  const get = async <Config>(
    entry: ProviderEntry,
    parse: (value: unknown) => Config
  ): Promise<Config | null> => {
    const settings = await readSettings(settingsPath());
    return Object.hasOwn(settings, entry) ? parse(settings[entry]) : null;
  };

  const save = <Config>(
    entry: ProviderEntry,
    value: unknown,
    parse: (value: unknown) => Config
  ): Promise<Config | null> => {
    const write = pendingWrite.then(async () => {
      const config = value === null ? null : parse(value);
      const file = settingsPath();
      const settings = await readSettings(file);
      if (config === null) delete settings[entry];
      else settings[entry] = config;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", {
          flag: "wx",
          mode: 0o600
        });
        await rename(temporary, file);
      } catch {
        throw new Error("Could not save external provider settings");
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return config;
    });
    pendingWrite = write.catch(() => {});
    return write;
  };

  return {
    get: (capability: ExternalModelCapability) =>
      get(capability, (value) => parseConfig(capability, value)),
    save: (capability: ExternalModelCapability, value: unknown) =>
      save(capability, value, (entry) => parseConfig(capability, entry)),
    getFal: () => get("fal", parseFalConfig),
    saveFal: (value: unknown) => save("fal", value, parseFalConfig)
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
  account: string
): Promise<string> => {
  if (process.platform !== "darwin")
    throw new Error(
      "External provider credentials currently require macOS Keychain"
    );
  let password: string;
  try {
    const { stdout } = await run(
      "/usr/bin/security",
      ["find-generic-password", "-s", keychainService, "-a", account, "-w"],
      { encoding: "utf8", timeout: 30_000 }
    );
    password = stdout.trim();
  } catch {
    throw new Error(
      "Could not read the external provider credential from macOS Keychain"
    );
  }
  if (!/^[!-~]+$/.test(password))
    throw new Error("The external provider credential is empty or invalid");
  return password;
};
