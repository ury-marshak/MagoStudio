import { useProject } from "@domains/project/useProject";
import { useState } from "react";

import {
  isFalGenerationModel,
  resolveFalGenerationSettings,
  type FalGenerationSettings
} from "../../../desktop/shared/falGenerationSettings";

import { useFalProviderConfig } from "./useFalProviderConfigured";
import { useSaveProjectSettingsPatch } from "./useSaveProjectSettingsPatch";

/** Overrides are scoped to both action and model; changing models never translates settings. */
export const useFalGenerationSettings = (projectId: string) => {
  const { data: project } = useProject(projectId);
  const fal = useFalProviderConfig(project?.origin === "local");
  const { saveProjectSettingsPatch, isSavingProjectSettings } =
    useSaveProjectSettingsPatch(projectId);
  const [overrides, setOverrides] = useState<
    Record<string, FalGenerationSettings>
  >({});
  const key = (model: string, action: string) =>
    `${projectId}:${action}:${model}`;
  const settingsFor = (
    model: string,
    action = "batch"
  ): FalGenerationSettings | undefined => {
    if (!isFalGenerationModel(model)) return undefined;
    return resolveFalGenerationSettings(
      model,
      { ...overrides[key(model, "batch")], ...overrides[key(model, action)] },
      project?.settings?.fal_generation_settings?.[model],
      fal.data?.generationSettings?.[model]
    );
  };
  return {
    settingsFor,
    change: (model: string, action: string, settings: FalGenerationSettings) =>
      setOverrides((previous) => ({
        ...previous,
        [key(model, action)]: settings
      })),
    save: (model: string, action = "batch") => {
      if (!isFalGenerationModel(model)) return;
      return saveProjectSettingsPatch({
        fal_generation_settings: {
          ...project?.settings?.fal_generation_settings,
          [model]: settingsFor(model, action)
        }
      });
    },
    isSaving: isSavingProjectSettings
  };
};
