import { describe, expect, it } from "vitest";

import {
  falVideoTailEstimate,
  falVideoTailEstimateSchema,
  FAL_H3_PRICING_SOURCE
} from "./falVideoTailPricing";

describe("fal sourced video-reference scenarios", () => {
  it.each([
    ["480P", 2, 0.01168],
    ["480P", 5, 0.16768],
    ["480P", 10, 0.44068],
    ["768P", 2, 0.16],
    ["768P", 5, 0.5632],
    ["768P", 10, 1.2688],
    ["1080P", 2, 0.16]
  ] as const)(
    "matches the published %s %ss video-only example",
    (resolution, seconds, surcharge) => {
      const estimate = falVideoTailEstimate("shot", resolution, 10, seconds);
      expect(estimate.example_reference_min_usd).toBeCloseTo(surcharge, 8);
      expect(estimate.example_reference_max_usd).toBeCloseTo(surcharge, 8);
      expect(estimate.source).toBe(FAL_H3_PRICING_SOURCE);
      expect(falVideoTailEstimateSchema.parse(estimate)).toEqual(estimate);
    }
  );
  it("shows adjacent published examples instead of inventing an exact per-frame price", () => {
    expect(falVideoTailEstimate("shot", "480P", 5, 3)).toMatchObject({
      output_base_usd: 0.25,
      example_from_seconds: 2,
      example_to_seconds: 5
    });
    expect(falVideoTailEstimate("shot", "480P", 5, 10)).toMatchObject({
      example_from_seconds: 5,
      example_to_seconds: 5
    });
    expect(falVideoTailEstimate("shot", "1080P", 5, 2).output_base_usd).toBe(
      0.8
    );
  });
});
