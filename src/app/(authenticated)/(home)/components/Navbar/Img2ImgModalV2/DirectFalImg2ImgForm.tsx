import { OrdinaryFalForm } from "@components/OrdinaryFal/OrdinaryFalForm";
import { isShotCroppedSectionOfInputVideo } from "@domains/renders/utils/cropRect";
import { useInputTrackFrameSrc } from "@domains/track/useInputTrackFrameSrc";
import { useShotCrop } from "@store/cropStore";
import { cropImageToNormalizedRect } from "@utils/image/cropImageToNormalizedRect";
import { useWatch } from "react-hook-form";

import {
  importLocalFalStill,
  ordinaryFalCanvas,
  readLocalFalImage
} from "@/domains/ordinaryFal/localFalImages";
import { OrdinaryFalActionError } from "@/domains/ordinaryFal/submitOrdinaryFal";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { resolveImg2ImgFrame } from "./hooks/utils/resolveImg2ImgFrame";
import type { Img2ImgType } from "./schemas";

export const DirectFalImg2ImgForm = ({
  projectId,
  shotId,
  currentFrame
}: {
  projectId?: string;
  shotId?: string;
  currentFrame: number;
}) => {
  const { work } = useRendererLibraryWork();
  const [frameType, iteratedAssetId, uploadedImageId, iteratedSourceFrame] =
    useWatch<
      Img2ImgType,
      ["frameType", "iteratedAssetId", "uploadedImageId", "iteratedSourceFrame"]
    >({
      name: [
        "frameType",
        "iteratedAssetId",
        "uploadedImageId",
        "iteratedSourceFrame"
      ]
    });
  const { inputTrackFrameSrc } = useInputTrackFrameSrc({
    frameNumber: currentFrame,
    enabled: frameType === "video"
  });
  const { crop } = useShotCrop();
  const existingBase =
    frameType === "upload" ? iteratedAssetId || uploadedImageId : undefined;
  const selectedStill = frameType === "video" ? inputTrackFrameSrc : undefined;
  const hasBaseImage = !!shotId && !!(existingBase || selectedStill);

  return (
    <OrdinaryFalForm
      kind="image-edit"
      projectId={projectId}
      hasBaseImage={hasBaseImage}
      prepare={async (check) => {
        if (!projectId || !shotId)
          throw new OrdinaryFalActionError("Select a shot first.");
        const frame = resolveImg2ImgFrame(
          frameType === "upload" ? iteratedAssetId : undefined,
          iteratedSourceFrame,
          currentFrame
        );
        if (!Number.isInteger(frame) || frame < 0)
          throw new OrdinaryFalActionError("Select a valid shot frame.");
        const { assets } = getLocalDesktopApi();
        if (existingBase) {
          const asset = await readLocalFalImage({
            assets,
            projectId,
            assetId: existingBase,
            work,
            check
          });
          return {
            shotId,
            frame,
            baseAssetId: asset.id,
            canvas: ordinaryFalCanvas(asset.data.width, asset.data.height)
          };
        }
        if (!selectedStill?.startsWith("data:image/"))
          throw new OrdinaryFalActionError(
            "Select a frame available as a local still."
          );
        const dataUrl =
          crop && isShotCroppedSectionOfInputVideo({ crop })
            ? await cropImageToNormalizedRect({ imageSrc: selectedStill, crop })
            : selectedStill;
        check();
        const base = await importLocalFalStill({
          assets,
          projectId,
          dataUrl,
          frame,
          work,
          check
        });
        return { shotId, frame, ...base };
      }}
    />
  );
};
