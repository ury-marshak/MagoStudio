import { OrdinaryFalForm } from "@components/OrdinaryFal/OrdinaryFalForm";
import { useImageToVideoContainerShot } from "@domains/shot/useImageToVideoContainerShot";
import { LayerType } from "@schemas/layer";

import { OrdinaryFalActionError } from "@/domains/ordinaryFal/submitOrdinaryFal";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

export const DirectFalImageToVideoForm = ({
  projectId
}: {
  projectId?: string;
}) => {
  const { work } = useRendererLibraryWork();
  const { ensureContainerShotId } = useImageToVideoContainerShot(projectId);

  return (
    <OrdinaryFalForm
      kind="reference-video"
      projectId={projectId}
      prepare={async (check) => {
        const shotId = await ensureContainerShotId(work);
        check();
        if (!shotId)
          throw new OrdinaryFalActionError(
            "Could not open the Image to Video shot."
          );
        // This is a local output track, independent of the legacy model or
        // account settings. No source video track is created or sent.
        const track = await work.boundary(() => {
          check();
          return getLocalDesktopApi().tracks.create({
            shotId,
            name: "MiniMax H3 Max (fal)",
            type: LayerType.RENDER,
            data: { renderEngine: "magov2", ordinaryFal: true },
            parentTrackOrder: 1
          });
        });
        check();
        if (typeof track.id !== "string" || !track.id)
          throw new OrdinaryFalActionError(
            "Could not create a local output track."
          );
        return { shotId, trackId: track.id, timelineOffsetMs: 0 };
      }}
    />
  );
};
