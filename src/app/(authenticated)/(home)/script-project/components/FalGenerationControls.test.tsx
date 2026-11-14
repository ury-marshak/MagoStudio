import { FalGenerationControls } from "@components/FalGenerationControls";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { resolveFalGenerationSettings } from "../../../../../../desktop/shared/falGenerationSettings";
import { FAL_SHEET_MODEL_H3 } from "../../../../../../desktop/shared/falSheetModel";
import { FAL_SHOT_ENGINE } from "../../../../../../desktop/shared/falShotModel";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));
afterEach(cleanup);
it("offers 480P for video and sends the selected value without saving a default", () => {
  const change = vi.fn(),
    save = vi.fn();
  render(
    <FalGenerationControls
      model={FAL_SHOT_ENGINE}
      settings={resolveFalGenerationSettings(FAL_SHOT_ENGINE)}
      onChange={change}
      onSave={save}
    />
  );
  fireEvent.change(
    screen.getByLabelText("script_project.fal_settings.resolution"),
    { target: { value: "480P" } }
  );
  expect(change).toHaveBeenCalledWith(
    expect.objectContaining({ resolution: "480P" })
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  expect(save).toHaveBeenCalledOnce();
});
it("shows only H3 Image controls and revalidates the form when switching models", () => {
  const { rerender } = render(
    <FalGenerationControls
      model={FAL_SHOT_ENGINE}
      settings={resolveFalGenerationSettings(FAL_SHOT_ENGINE)}
      onChange={vi.fn()}
    />
  );
  expect(
    screen.getByLabelText("script_project.fal_settings.seed")
  ).toBeInTheDocument();
  rerender(
    <FalGenerationControls
      model={FAL_SHEET_MODEL_H3}
      settings={resolveFalGenerationSettings(FAL_SHEET_MODEL_H3)}
      onChange={vi.fn()}
    />
  );
  expect(
    screen.queryByLabelText("script_project.fal_settings.seed")
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("script_project.fal_settings.resolution")
  ).not.toBeInTheDocument();
  expect(
    screen.getByLabelText("script_project.fal_settings.megapixels")
  ).toBeInTheDocument();
});
