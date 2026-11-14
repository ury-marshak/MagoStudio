import { CreditCoin } from "@components/CreditCoin";
import { Text } from "@components/Text";
import { useTranslation } from "react-i18next";

const falSheetUsd = 0.08;

export type ScriptProjectRenderCost =
  | { kind: "credits"; amount: number }
  | { kind: "local" }
  | { kind: "fal"; count: number }
  | { kind: "fal-usage" }
  | null;

type Props = {
  cost: ScriptProjectRenderCost;
  isDisabled: boolean;
};

export const RenderCostLabel: React.FC<Props> = ({ cost, isDisabled }) => {
  const { t, i18n } = useTranslation();
  if (!cost) return null;
  if (cost.kind === "fal-usage")
    return (
      <Text component="span" variant="sm" color="glyph-secondary">
        {t("script_project.fal_usage.label")}
      </Text>
    );
  if (cost.kind === "fal") {
    const amount = new Intl.NumberFormat(i18n.language, {
      style: "currency",
      currency: "USD"
    }).format(cost.count * falSheetUsd);
    return (
      <Text component="span" variant="sm" color="glyph-secondary">
        {t("script_project.sheet_fal_estimate.label", { amount })}
      </Text>
    );
  }

  if (cost.kind === "local") {
    return (
      <Text component="span" variant="sm" color="glyph-secondary">
        Local
      </Text>
    );
  }

  return (
    <CreditCoin
      count={cost.amount}
      disabled={isDisabled}
      marginLeft
      monochrome
    />
  );
};
