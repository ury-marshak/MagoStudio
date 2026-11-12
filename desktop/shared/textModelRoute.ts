import type { LocalTextModelProvider } from "./contracts";

export type TextModelRoute = "local" | "cloud" | "external";

export const resolveTextModelRoute = ({
  provider,
  isCloudAccountActive,
  hasExternalText = false
}: {
  provider: LocalTextModelProvider;
  isCloudAccountActive: boolean;
  hasExternalText?: boolean;
}): TextModelRoute => {
  if (hasExternalText) return "external";
  return provider === "cloud" && isCloudAccountActive ? "cloud" : "local";
};
