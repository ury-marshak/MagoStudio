import { getAssetPrompt } from "@domains/asset/getAssetPrompt";
import { selectPromptWithFormattedText } from "@domains/asset/utils/selectPromptWithFormattedText";
import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

export const useFetchBulkRenderingDraftAutoPromptText = () => {
  const scope = useRendererLibraryQueryScope();
  const queryClient = useQueryClient();

  const fetchAutoPromptText = async (
    videoAssetId: string
  ): Promise<string | undefined> => {
    scope.work.check();
    const promptResponse = await queryClient.fetchQuery({
      queryKey: scope.key(queryKeys.assetPrompt.byId(videoAssetId)),
      queryFn: ({ signal }) =>
        scope.run(() =>
          getAssetPrompt(
            videoAssetId,
            AbortSignal.any([signal, scope.work.signal])
          )
        ),
      retry: false,
      staleTime: Infinity
    });

    scope.work.check();
    return selectPromptWithFormattedText(promptResponse)?.formattedText;
  };

  return { fetchAutoPromptText };
};
