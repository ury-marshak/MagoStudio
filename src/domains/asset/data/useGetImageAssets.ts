import { useQuery, useQueryClient } from "@tanstack/react-query";

import { isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import { getImageAsset } from "../api/getImageAsset";
import { ImageAssetResponse } from "../api/interface";
import { resolveSettledAssetResults } from "../utils/resolveSettledAssetResults";

type UseGetImageAssetsParams<TSelected> = {
  assetIds: string[];
  enabled?: boolean;
  selectAll?: (data: (ImageAssetResponse | undefined)[]) => TSelected;
};

export const useGetImageAssets = <
  TSelected = (ImageAssetResponse | undefined)[]
>({
  assetIds,
  enabled = true,
  selectAll
}: UseGetImageAssetsParams<TSelected>) => {
  const queryClient = useQueryClient();
  const scope = useRendererLibraryQueryScope();
  const assetKey = (id: string) => scope.key(queryKeys.imageAsset.byId(id));
  const validAssetIds = assetIds.filter((id) => !!id);
  const uncachedIds = validAssetIds.filter(
    (id) => !queryClient.getQueryData(assetKey(id))
  );
  const sortedUncachedIds = [...uncachedIds].sort();
  const queryKey = scope.key(
    queryKeys.imageAssetBatch.forIds(sortedUncachedIds)
  );
  const batchQuery = useQuery({
    queryKey,
    retry: scope.retry(queryKey),
    queryFn: () =>
      scope.run(async () => {
        const settled = await Promise.allSettled(
          sortedUncachedIds.map((id) => getImageAsset(id, scope.work))
        );

        scope.work.check();
        const results = resolveSettledAssetResults(settled);

        sortedUncachedIds.forEach((id, index) => {
          if (results[index]) {
            queryClient.setQueryData(assetKey(id), results[index]);
          }
        });

        return results;
      }),
    enabled: scope.active && enabled && uncachedIds.length > 0,
    staleTime: Infinity,
    gcTime: isLocalApp ? undefined : Infinity
  });
  const allData = (() => {
    void batchQuery.data;
    return validAssetIds.map((id) =>
      queryClient.getQueryData<ImageAssetResponse>(assetKey(id))
    );
  })();
  const transformedData = selectAll
    ? selectAll(allData)
    : (allData as TSelected);
  return {
    data: transformedData,
    isLoading: batchQuery.isLoading,
    error: batchQuery.error ? true : false
  };
};
