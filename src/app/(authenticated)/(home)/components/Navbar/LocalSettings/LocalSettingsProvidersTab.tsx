import { FalGenerationControls } from "@components/FalGenerationControls";
import { Input } from "@components/Input";
import { MainButton } from "@components/MainButton";
import { Text } from "@components/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { queryKeys } from "@/queryKeys";

import { externalReasoningEfforts } from "../../../../../../../desktop/shared/contracts";
import type {
  ExternalModelCapability,
  ExternalModelConfig,
  FalProviderConfig
} from "../../../../../../../desktop/shared/contracts";
import {
  resolveFalGenerationSettings,
  type FalGenerationModel
} from "../../../../../../../desktop/shared/falGenerationSettings";
import { FAL_SHEET_MODELS } from "../../../../../../../desktop/shared/falSheetModel";
import { FAL_SHOT_ENGINE } from "../../../../../../../desktop/shared/falShotModel";
import { FAL_SHOT_PROVIDER } from "../../../../../../../desktop/shared/falShotModel";

type SavedProviderConfig = ExternalModelConfig | FalProviderConfig | null;
type ProviderDraft = ExternalModelConfig & FalProviderConfig;
const shotProviders = [FAL_SHOT_PROVIDER, "local-comfy"] as const;

const defaultConfig: ExternalModelConfig = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "",
  keychainAccount: "openrouter"
};

const ProviderSettings = ({
  capability
}: {
  capability: ExternalModelCapability | "fal";
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Partial<ProviderDraft>>({});
  const queryKey = queryKeys.externalProviders.capability(capability);
  const saved = useQuery({
    queryKey,
    queryFn: (): Promise<SavedProviderConfig> =>
      capability === "fal"
        ? window.mago.externalProviders.fal.get()
        : window.mago.externalProviders.get(capability),
    retry: false
  });
  const check = useMutation({
    mutationFn: () =>
      capability === "fal"
        ? window.mago.externalProviders.fal.check()
        : window.mago.externalProviders.check(capability)
  });
  const save = useMutation({
    mutationFn: (config: ProviderDraft | null): Promise<SavedProviderConfig> =>
      capability === "fal"
        ? window.mago.externalProviders.fal.save(
            config && {
              keychainAccount: config.keychainAccount,
              ...(config.generationSettings
                ? { generationSettings: config.generationSettings }
                : {}),
              ...(config.referenceImageModel
                ? { referenceImageModel: config.referenceImageModel }
                : {}),
              ...(config.storyboardImageModel
                ? { storyboardImageModel: config.storyboardImageModel }
                : {}),
              ...(config.shotProvider
                ? { shotProvider: config.shotProvider }
                : {})
            }
          )
        : window.mago.externalProviders.save(
            capability,
            config && {
              baseUrl: config.baseUrl,
              model: config.model,
              keychainAccount: config.keychainAccount,
              ...(config.reasoningEffort
                ? { reasoningEffort: config.reasoningEffort }
                : {})
            }
          ),
    onSuccess: async (config) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, config);
      setDraft({});
      if (capability === "fal") return;
      await queryClient.invalidateQueries({
        queryKey:
          capability === "text"
            ? queryKeys.externalProviders.configuredText
            : queryKeys.vlmStatus.all
      });
    }
  });

  const heading = t(`localSettings.providers.${capability}`);
  const config: ProviderDraft = {
    ...defaultConfig,
    keychainAccount: capability === "fal" ? "" : defaultConfig.keychainAccount,
    ...saved.data,
    ...draft
  };
  const fields =
    capability === "fal"
      ? (["keychainAccount"] as const)
      : (["baseUrl", "model", "keychainAccount"] as const);
  const showReasoning =
    capability !== "fal" &&
    URL.parse(config.baseUrl.trim())?.hostname === "openrouter.ai";
  const falImageOptions = FAL_SHEET_MODELS.map((model) => ({
    key: model,
    label: t(`script_project.sheet_render_model_${model}.label`)
  }));
  const changed = Object.keys(draft).length > 0;
  const busy = saved.isPending || save.isPending || check.isPending;
  const error = save.error ?? check.error ?? saved.error;

  return (
    <form
      aria-label={heading}
      className="flex flex-col gap-2 rounded-md border border-element-primary p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !changed) return;
        check.reset();
        save.mutate({
          baseUrl: config.baseUrl.trim(),
          model: config.model.trim(),
          keychainAccount: config.keychainAccount.trim(),
          generationSettings: config.generationSettings,
          referenceImageModel: config.referenceImageModel,
          storyboardImageModel: config.storyboardImageModel,
          shotProvider: config.shotProvider,
          ...(showReasoning && config.reasoningEffort
            ? { reasoningEffort: config.reasoningEffort }
            : {})
        });
      }}
    >
      <Text component="h3" variant="sm" weight="bold">
        {heading}
      </Text>
      {capability === "fal" && (
        <Text variant="xs" color="glyph-secondary">
          {t("localSettings.providers.falHint")}
        </Text>
      )}
      {fields.map((field) => (
        <label key={field} className="flex flex-col gap-1">
          <Text component="span" variant="xs" color="glyph-secondary">
            {t(`localSettings.providers.${field}`)}
          </Text>
          <Input
            value={config[field]}
            type={field === "baseUrl" ? "url" : "text"}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
            onChange={(event) => {
              setDraft({ ...draft, [field]: event.target.value });
              save.reset();
              check.reset();
            }}
          />
        </label>
      ))}
      {capability === "fal" &&
        (
          [
            {
              field: "referenceImageModel",
              options: falImageOptions
            },
            {
              field: "storyboardImageModel",
              options: falImageOptions
            },
            {
              field: "shotProvider",
              options: shotProviders.map((provider) => ({
                key: provider,
                label: t(
                  provider === FAL_SHOT_PROVIDER
                    ? "script_project.shot_fal_model.label"
                    : "script_project.shot_comfy_model.label"
                )
              }))
            }
          ] as const
        ).map(({ field, options }) => (
          <label key={field} className="flex flex-col gap-1">
            <Text component="span" variant="xs" color="glyph-secondary">
              {t(`localSettings.providers.${field}`)}
            </Text>
            <select
              className="rounded-md border border-element-primary bg-transparent p-2 text-sm"
              value={config[field] ?? ""}
              disabled={busy}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  [field]: options.find(({ key }) => key === event.target.value)
                    ?.key
                });
                save.reset();
                check.reset();
              }}
            >
              <option value="">
                {t("localSettings.providers.appDefault")}
              </option>
              {options.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
      {capability === "fal" &&
        [...FAL_SHEET_MODELS, FAL_SHOT_ENGINE].map((model) => (
          <div key={model} className="flex flex-col gap-1">
            <Text variant="xs">
              {model === FAL_SHOT_ENGINE
                ? "H3 Max (fal)"
                : t(`script_project.sheet_render_model_${model}.label`)}
            </Text>
            <FalGenerationControls
              model={model}
              settings={resolveFalGenerationSettings(
                model as FalGenerationModel,
                config.generationSettings?.[model as FalGenerationModel]
              )}
              disabled={busy}
              onChange={(settings) => {
                setDraft({
                  ...draft,
                  generationSettings: {
                    ...config.generationSettings,
                    [model]: settings
                  }
                });
                save.reset();
                check.reset();
              }}
            />
          </div>
        ))}
      {showReasoning && (
        <label className="flex flex-col gap-1">
          <Text component="span" variant="xs" color="glyph-secondary">
            {t("localSettings.providers.reasoningEffort")}
          </Text>
          <select
            className="rounded-md border border-element-primary bg-transparent p-2 text-sm"
            value={config.reasoningEffort ?? ""}
            disabled={busy}
            onChange={(event) => {
              const reasoningEffort = externalReasoningEfforts.find(
                (effort) => effort === event.target.value
              );
              setDraft({ ...draft, reasoningEffort });
              save.reset();
              check.reset();
            }}
          >
            <option value="">
              {t("localSettings.providers.reasoningDefault")}
            </option>
            {externalReasoningEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {t(`localSettings.providers.reasoningLevels.${effort}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <MainButton
          colorScheme="primary"
          type="submit"
          isDisabled={busy || !changed}
        >
          {t("localSettings.providers.save")}
        </MainButton>
        <MainButton
          colorScheme="secondary"
          isDisabled={busy || changed || !saved.data}
          onPress={() => {
            save.reset();
            check.mutate();
          }}
        >
          {t(
            capability === "fal"
              ? "localSettings.providers.checkKeychain"
              : "localSettings.providers.check"
          )}
        </MainButton>
        {(saved.data || saved.isError) && (
          <MainButton
            variant="outlined"
            colorScheme="danger"
            isDisabled={busy}
            onPress={() => {
              check.reset();
              save.mutate(null);
            }}
          >
            {t("localSettings.providers.remove")}
          </MainButton>
        )}
      </div>
      {error ? (
        <div role="alert">
          <Text variant="xs" color="glyph-error">
            {error.message}
          </Text>
        </div>
      ) : (
        <div role="status">
          <Text variant="xs" color="glyph-secondary">
            {check.isSuccess
              ? t(
                  capability === "fal"
                    ? "localSettings.providers.checkKeychainPassed"
                    : "localSettings.providers.checkPassed"
                )
              : save.isSuccess
                ? t(
                    save.data
                      ? "localSettings.providers.saved"
                      : "localSettings.providers.removed"
                  )
                : check.isPending
                  ? t(
                      capability === "fal"
                        ? "localSettings.providers.checkingKeychain"
                        : "localSettings.providers.checking"
                    )
                  : undefined}
          </Text>
        </div>
      )}
    </form>
  );
};

export const LocalSettingsProvidersTab = () => {
  const { t } = useTranslation();

  return (
    <>
      <Text variant="xs" color="glyph-secondary">
        {t("localSettings.providers.keychainHint")}
      </Text>
      <ProviderSettings capability="text" />
      <ProviderSettings capability="vision" />
      <ProviderSettings capability="fal" />
    </>
  );
};
