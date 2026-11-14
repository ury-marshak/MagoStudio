import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test-utils/renderWithProviders";

import {
  falVideoTailEstimate,
  FAL_H3_PRICING_SOURCE
} from "../../../../../../desktop/shared/falVideoTailPricing";

import { FalVideoTailCostNote } from "./FalVideoTailCostNote";

describe("FalVideoTailCostNote", () => {
  it("does not show a surcharge when no video-tail work is planned", () => {
    const screen = renderWithProviders(<FalVideoTailCostNote estimates={[]} />);
    expect(screen.queryByTestId("fal-video-tail-cost-note")).toBeNull();
  });
  it("separates output base from sourced reference scenarios and never promises a total", () => {
    const screen = renderWithProviders(
      <FalVideoTailCostNote
        estimates={[falVideoTailEstimate("shot", "480P", 5, 3)]}
      />
    );
    const note = screen.getByTestId("fal-video-tail-cost-note");
    expect(note).toHaveTextContent("$0.25");
    expect(note).toHaveTextContent("$0.01168");
    expect(note).toHaveTextContent("$0.16768");
    expect(note).toHaveTextContent("Images add usage");
    expect(note).toHaveTextContent("not a total or a price bound");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      FAL_H3_PRICING_SOURCE
    );
  });
});
