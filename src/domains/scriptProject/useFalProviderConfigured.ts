import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/queryKeys";

export const useFalProviderConfig = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.externalProviders.capability("fal"),
    queryFn: () => window.mago?.externalProviders?.fal?.get() ?? null,
    enabled,
    retry: false
  });

export const useFalProviderConfigured = (enabled: boolean): boolean =>
  !!useFalProviderConfig(enabled).data && enabled;
