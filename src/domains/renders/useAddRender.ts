import { useCloudSyncProgressToast } from "@domains/cloud/useCloudSyncProgressToast";
import { useSelectedProjectId } from "@domains/project/useSelectedProjectId";
import { useSelectedShotId } from "@domains/shot/useSelectedShotId";
import { trackingUtils } from "@hooks/tracking/trackingUtils";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { PostRenderParams } from "./api/postRender";
import { usePostRender } from "./data/usePostRender";

export const useAddRender = () => {
  const selectedProjectId = useSelectedProjectId();
  const { selectedShotId } = useSelectedShotId();
  const { begin } = useCloudSyncProgressToast();

  const mutation = usePostRender({
    selectedProjectId,
    selectedShotId
  });

  return {
    ...mutation,
    mutateAsync: async (
      params: PostRenderParams,
      work = rendererLibrary.capture()
    ) => {
      await work.ready();
      work.check();
      void Notification.requestPermission().then((permission) => {
        if (!work.signal.aborted)
          trackingUtils.magoActions.notificationPermission(permission);
      });
      const { onProgress, dismiss } = begin(work);
      try {
        return await mutation.mutateAsync({ params, onProgress }, work);
      } finally {
        dismiss();
      }
    }
  };
};
