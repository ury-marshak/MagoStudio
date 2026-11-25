import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { putImageAsset } from "../api/putImageAsset";

export const usePutImageAsset = ({ assetId }: { assetId: string }) => {
  const queryClient = useQueryClient();
  const { work } = useRendererLibraryWork();
  const mutation = useRendererLibraryMutation({
    mutationFn: (changes: { rate: number }, origin) =>
      putImageAsset(assetId, changes, origin),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.imageAsset.byId(assetId)
      });
    }
  });
  return {
    ...mutation,
    mutate: (changes: { rate: number }) => {
      if (!work.signal.aborted) mutation.mutate(changes, work);
    },
    mutateAsync: (changes: { rate: number }) =>
      mutation.mutateAsync(changes, work)
  };
};
