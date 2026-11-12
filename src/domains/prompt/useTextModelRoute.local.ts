import { useQuery } from "@tanstack/react-query";

import { isCloudAccountActive } from "@/platform/cloudAccount";
import { queryKeys } from "@/queryKeys";

import {
  resolveTextModelRoute,
  type TextModelRoute
} from "../../../desktop/shared/textModelRoute";

export type { TextModelRoute } from "../../../desktop/shared/textModelRoute";

export const useTextModelRoute = (): {
  route: TextModelRoute;
  routeLabel?: string;
  isRoutePending: boolean;
} => {
  const hasBridge = typeof window !== "undefined" && !!window.mago;
  const external = useQuery({
    queryKey: queryKeys.externalProviders.configuredText,
    queryFn: () => window.mago.vlm.hasExternalText(),
    enabled: hasBridge,
    retry: false
  });
  const settings = useQuery({
    queryKey: queryKeys.comfySettings.all,
    queryFn: () => window.mago.comfy.get(),
    enabled: hasBridge && external.data === false,
    staleTime: Infinity
  });
  const route = resolveTextModelRoute({
    provider: settings.data?.textModelProvider ?? "cloud",
    isCloudAccountActive: isCloudAccountActive(),
    hasExternalText: external.data
  });
  if (
    hasBridge &&
    (external.isPending || (external.data === false && settings.isPending))
  )
    return { route, isRoutePending: true };
  if (hasBridge && external.isError)
    return { route, routeLabel: "(unavailable)", isRoutePending: false };
  return { route, routeLabel: `(${route})`, isRoutePending: false };
};
