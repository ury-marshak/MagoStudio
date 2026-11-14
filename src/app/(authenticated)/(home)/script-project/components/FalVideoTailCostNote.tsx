import { Text } from "@components/Text";
import { useTranslation } from "react-i18next";

import type { FalVideoTailEstimate } from "../../../../../../desktop/shared/falVideoTailPricing";

export const FalVideoTailCostNote = ({
  estimates
}: {
  estimates: FalVideoTailEstimate[];
}) => {
  const { t, i18n } = useTranslation();
  if (!estimates.length) return null;
  const usd = (amount: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 5
    }).format(amount);
  return (
    <div
      className="max-h-48 w-full min-w-0 overflow-y-auto break-words"
      data-testid="fal-video-tail-cost-note"
    >
      {estimates.map((estimate) => (
        <Text
          key={estimate.timeline_id}
          component="p"
          variant="xs"
          color="glyph-secondary"
        >
          {t("script_project.fal_video_tail_estimate.label", {
            base: usd(estimate.output_base_usd),
            min: usd(estimate.example_reference_min_usd),
            max: usd(estimate.example_reference_max_usd),
            from: estimate.example_from_seconds,
            to: estimate.example_to_seconds
          })}
        </Text>
      ))}
      <a
        className="text-xs underline"
        href={estimates[0]!.source}
        target="_blank"
        rel="noreferrer"
      >
        {t("script_project.fal_video_tail_pricing_source.label")}
      </a>
    </div>
  );
};
