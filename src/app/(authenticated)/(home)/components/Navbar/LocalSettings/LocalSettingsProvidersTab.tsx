import { Input } from "@components/Input";
import { MainButton } from "@components/MainButton";
import { Text } from "@components/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { queryKeys } from "@/queryKeys";

import type {
  ExternalModelCapability,
  ExternalModelConfig
} from "../../../../../../../desktop/shared/contracts";

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
  const [draft, setDraft] = useState<Partial<ExternalModelConfig>>({});
  const queryKey = queryKeys.externalProviders.capability(capability);
  const saved = useQuery({
    queryKey,
    queryFn: () =>
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
    mutationFn: (config: ExternalModelConfig | null) =>
      capability === "fal"
        ? window.mago.externalProviders.fal.save(
            config && { keychainAccount: config.keychainAccount }
          )
        : window.mago.externalProviders.save(capability, config),
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
  const config = {
    ...defaultConfig,
    keychainAccount: capability === "fal" ? "" : defaultConfig.keychainAccount,
    ...saved.data,
    ...draft
  };
  const fields =
    capability === "fal"
      ? (["keychainAccount"] as const)
      : (["baseUrl", "model", "keychainAccount"] as const);
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
          keychainAccount: config.keychainAccount.trim()
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
