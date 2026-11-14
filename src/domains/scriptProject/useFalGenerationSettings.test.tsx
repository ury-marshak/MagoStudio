import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3
} from "../../../desktop/shared/falSheetModel";

import { useFalGenerationSettings } from "./useFalGenerationSettings";
const { save, project, app } = vi.hoisted(() => ({
  save: vi.fn(),
  project: {
    origin: "local",
    settings: {
      fal_generation_settings: { fal_nano_banana_2_1: { resolution: "2K" } }
    }
  },
  app: {
    generationSettings: {
      fal_nano_banana_2_1: { resolution: "1K", thinking_level: "high" }
    }
  }
}));
vi.mock("@domains/project/useProject", () => ({
  useProject: () => ({ data: project })
}));
vi.mock("./useFalProviderConfigured", () => ({
  useFalProviderConfig: () => ({ data: app })
}));
vi.mock("./useSaveProjectSettingsPatch", () => ({
  useSaveProjectSettingsPatch: () => ({
    saveProjectSettingsPatch: save,
    isSavingProjectSettings: false
  })
}));

it("isolates action and model overrides, preserves defaults, and saves only explicitly", () => {
  const { result, rerender } = renderHook(
    ({ id }) => useFalGenerationSettings(id),
    { initialProps: { id: "p" } }
  );
  expect(result.current.settingsFor(FAL_SHEET_MODEL_21)).toMatchObject({
    resolution: "2K",
    thinking_level: "high"
  });
  act(() =>
    result.current.change(FAL_SHEET_MODEL_21, "batch", { resolution: "4K" })
  );
  expect(
    result.current.settingsFor(FAL_SHEET_MODEL_21, "draft:a")?.resolution
  ).toBe("4K");
  act(() =>
    result.current.change(FAL_SHEET_MODEL_21, "draft:a", { resolution: "1K" })
  );
  expect(
    result.current.settingsFor(FAL_SHEET_MODEL_21, "draft:a")?.resolution
  ).toBe("1K");
  expect(
    result.current.settingsFor(FAL_SHEET_MODEL_21, "group:b")?.resolution
  ).toBe("4K");
  expect(result.current.settingsFor(FAL_SHEET_MODEL_21)?.resolution).toBe("4K");
  expect(result.current.settingsFor(FAL_SHEET_MODEL_H3, "draft:a")).toEqual({
    megapixels: "1",
    aspect_ratio: "layout"
  });
  expect(
    result.current.settingsFor(FAL_SHEET_MODEL, "draft:a")?.resolution
  ).toBe("1K");
  expect(save).not.toHaveBeenCalled();
  act(() => {
    result.current.save(FAL_SHEET_MODEL_21, "draft:a");
  });
  expect(save).toHaveBeenCalledWith({
    fal_generation_settings: {
      fal_nano_banana_2_1: expect.objectContaining({
        resolution: "1K",
        thinking_level: "high"
      })
    }
  });
  rerender({ id: "other" });
  expect(
    result.current.settingsFor(FAL_SHEET_MODEL_21, "draft:a")?.resolution
  ).toBe("2K");
});
