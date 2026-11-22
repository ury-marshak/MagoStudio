import { findMissingReferenceCloudAssetId } from "./findMissingReferenceCloudAssetId";

export interface MirroredAdaptPromptReference {
  localAssetId: string;
  cloudAssetId: string;
}

export const adaptWithStaleCloudReferencesReplaced = async <TAdapted>({
  mirrorReferences,
  adapt,
  markReferenceStale,
  signal
}: {
  mirrorReferences: () => Promise<MirroredAdaptPromptReference[]>;
  adapt: (cloudAssetIds: string[]) => Promise<TAdapted>;
  markReferenceStale: (localAssetId: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<TAdapted> => {
  const replacedLocalAssetIds = new Set<string>();
  for (;;) {
    signal?.throwIfAborted();
    const references = await mirrorReferences();
    try {
      signal?.throwIfAborted();
      const adapted = await adapt(
        references.map((reference) => reference.cloudAssetId)
      );
      signal?.throwIfAborted();
      return adapted;
    } catch (error) {
      signal?.throwIfAborted();
      const missingCloudAssetId = findMissingReferenceCloudAssetId(error);
      const staleReference = references.find(
        (reference) => reference.cloudAssetId === missingCloudAssetId
      );
      const canReplaceStaleReference =
        !!staleReference &&
        !replacedLocalAssetIds.has(staleReference.localAssetId);
      if (!canReplaceStaleReference) throw error;
      replacedLocalAssetIds.add(staleReference.localAssetId);
      await markReferenceStale(staleReference.localAssetId);
    }
  }
};
