import { useQuery } from "@tanstack/react-query";

import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import { isAssetPromptGeneratedInCloud } from "../api/isAssetPromptGeneratedInCloud";

export const useIsAssetPromptGeneratedInCloud = ({
  assetId,
  enabled = true
}: {
  assetId: string | undefined;
  enabled?: boolean;
}) => {
  const scope = useRendererLibraryQueryScope();
  const queryKey = scope.key(
    queryKeys.assetPromptGeneratedInCloud.byId(assetId)
  );
  const { data: isPromptGeneratedInCloud = false } = useQuery({
    queryKey,
    retry: scope.retry(queryKey),
    queryFn: () =>
      scope.run(async () => {
        if (!assetId) throw new Error("Asset ID is required");
        return isAssetPromptGeneratedInCloud(assetId);
      }),
    enabled: scope.active && enabled && !!assetId,
    staleTime: Infinity
  });

  return { isPromptGeneratedInCloud };
};
