import { z } from "zod";

/** Public fal pricing examples, checked 2026-11-14. Not a live quote or usage receipt. */
export const FAL_H3_PRICING_SOURCE =
  "https://fal.ai/models/minimax/h3-max/reference-to-video";
const includedTokens = 4096;
const usdPerThousandTokens = 0.02;
const tokensPerBillingUnit = 1000;
const usdPerToken = usdPerThousandTokens / tokensPerBillingUnit;
const rate = { "480P": 0.05, "768P": 0.08, "1080P": 0.16 } as const;
// Published 24fps 16:9/9:16 examples; do NOT invent a per-second token formula.
const examples = [
  { seconds: 2, low: 4680, high: 12096 },
  { seconds: 5, low: 12480, high: 32256 },
  { seconds: 10, low: 26130, high: 67536 }
];
export const falVideoTailEstimateSchema = z.object({
  timeline_id: z.string(),
  resolution: z.enum(["480P", "768P", "1080P"]),
  output_base_usd: z.number().nonnegative(),
  example_from_seconds: z.number(),
  example_to_seconds: z.number(),
  example_reference_min_usd: z.number().nonnegative(),
  example_reference_max_usd: z.number().nonnegative(),
  source: z.literal(FAL_H3_PRICING_SOURCE)
});
export type FalVideoTailEstimate = z.infer<typeof falVideoTailEstimateSchema>;

/**
 * A sourced scenario band, NOT a bound/quote for this job: video-only allowance,
 * 24fps and 16:9/9:16 references, enough source frames. Images cost extra and
 * share that allowance. For unsampled frame counts show adjacent published
 * examples, never interpolate a supposedly exact token count. Other shapes and
 * shorter predecessors can differ. Provider reference_tokens is actual usage.
 */
export const falVideoTailEstimate = (
  timelineId: string,
  resolution: unknown,
  outputSeconds: number,
  tailSeconds: number
): FalVideoTailEstimate => {
  const resolved =
    resolution === "480P" || resolution === "1080P" ? resolution : "768P";
  const seconds = Math.min(outputSeconds, tailSeconds);
  const from =
    examples.filter((item) => item.seconds <= seconds).at(-1) ?? examples[0]!;
  const to =
    examples.find((item) => item.seconds >= seconds) ?? examples.at(-1)!;
  const surcharge = (item: typeof from) =>
    Math.max(0, (resolved === "480P" ? item.low : item.high) - includedTokens) *
    usdPerToken;
  return {
    timeline_id: timelineId,
    resolution: resolved,
    output_base_usd: outputSeconds * rate[resolved],
    example_from_seconds: from.seconds,
    example_to_seconds: to.seconds,
    example_reference_min_usd: surcharge(from),
    example_reference_max_usd: surcharge(to),
    source: FAL_H3_PRICING_SOURCE
  };
};
