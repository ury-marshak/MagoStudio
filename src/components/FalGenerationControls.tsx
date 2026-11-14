import { useTranslation } from "react-i18next";

import {
  MAX_FAL_SEED,
  imageAspects,
  videoAspects,
  isFalGenerationModel,
  type FalGenerationSettings
} from "../../desktop/shared/falGenerationSettings";
import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_H3
} from "../../desktop/shared/falSheetModel";
import { FAL_SHOT_ENGINE } from "../../desktop/shared/falShotModel";

type Props = {
  model: string;
  settings?: FalGenerationSettings;
  onChange: (settings: FalGenerationSettings) => void;
  onSave?: () => void;
  disabled?: boolean;
};
export const FalGenerationControls = ({
  model,
  settings,
  onChange,
  onSave,
  disabled
}: Props) => {
  const { t } = useTranslation();
  if (!isFalGenerationModel(model) || !settings) return null;
  const video = model === FAL_SHOT_ENGINE;
  const h3 = model === FAL_SHEET_MODEL_H3;
  const fields = [
    ...(h3
      ? [{ key: "megapixels", options: ["1", "2", "4", "8", "16"] }]
      : [
          {
            key: "resolution",
            options: video
              ? ["480P", "768P", "1080P"]
              : model === FAL_SHEET_MODEL
                ? ["0.5K", "1K", "2K", "4K"]
                : ["1K", "2K", "4K"]
          }
        ]),
    {
      key: "aspect_ratio",
      options: [...(video ? videoAspects : imageAspects)]
    },
    ...(video
      ? [
          {
            key: "prompt_expansion_mode",
            options: ["disabled", "balanced", "quality"]
          }
        ]
      : h3
        ? []
        : [
            {
              key: "thinking_level",
              options:
                model === FAL_SHEET_MODEL
                  ? ["minimal", "high"]
                  : ["minimal", "medium", "high"]
            }
          ])
  ];
  return (
    <div
      className="flex min-w-0 max-w-full flex-wrap items-end gap-2"
      data-testid="fal-generation-controls"
    >
      {fields.map(({ key, options }) => (
        <label className="flex flex-col gap-1 text-xs" key={key}>
          {t(`script_project.fal_settings.${key}`)}
          <select
            aria-label={t(`script_project.fal_settings.${key}`)}
            disabled={disabled}
            className="rounded-md border border-element-primary bg-transparent p-2"
            value={settings[key] ?? ""}
            onChange={(event) =>
              onChange(
                Object.fromEntries(
                  Object.entries({
                    ...settings,
                    [key]: event.target.value
                  }).filter(([, value]) => value !== "")
                )
              )
            }
          >
            {key === "aspect_ratio" && !video && (
              <option value="layout">
                {t("script_project.fal_settings.layout_aspect")}
              </option>
            )}
            {options.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ))}
      {!h3 && (
        <label className="flex flex-col gap-1 text-xs">
          {t("script_project.fal_settings.seed")}
          <input
            aria-label={t("script_project.fal_settings.seed")}
            type="number"
            min={0}
            max={MAX_FAL_SEED}
            step={1}
            placeholder={t("script_project.fal_settings.random")}
            disabled={disabled}
            value={settings.seed ?? ""}
            className="w-28 rounded-md border border-element-primary bg-transparent p-2"
            onChange={(event) => {
              const next = { ...settings };
              if (event.target.value === "") next.seed = null;
              else {
                const seed = Number(event.target.value);
                if (!Number.isInteger(seed) || seed < 0 || seed > MAX_FAL_SEED)
                  return;
                next.seed = seed;
              }
              onChange(next);
            }}
          />
        </label>
      )}
      <span className="text-xs text-glyph-secondary">
        {t(
          video
            ? "script_project.fal_settings.video_fixed"
            : h3
              ? "script_project.fal_settings.h3_fixed"
              : "script_project.fal_settings.image_fixed"
        )}
      </span>
      {onSave && (
        <button
          type="button"
          disabled={disabled}
          onClick={onSave}
          className="text-xs underline"
        >
          {t("script_project.fal_settings.save")}
        </button>
      )}
    </div>
  );
};
