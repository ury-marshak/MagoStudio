import { getImg2ImgClipCrop } from "@domains/renders/utils/getImg2ImgClipCrop";
import { Clip } from "@schemas/clip";
import React from "react";

import { useClipNavigation } from "../hooks/useClipNavigation";

import { Img2ImgRenderActions } from "./Img2ImgRenderActions";
import { Img2ImgRenderHeader } from "./Img2ImgRenderHeader";
import { Img2ImgRenderImage } from "./Img2ImgRenderImage";

type Props = {
  index: number;
  generationIndex: number;
  allClips: Clip[];
  disableIterate?: boolean;
};

export const Img2ImgRender: React.FC<Props> = ({
  index,
  generationIndex,
  allClips,
  disableIterate = false
}) => {
  const {
    currentClip,
    assetId,
    clipId,
    clipStatus,
    sourceFrame,
    inputImageId,
    inputImageUrl,
    drawnMaskImageId,
    filename,
    canNavigatePrev,
    canNavigateNext,
    onNavigatePrev,
    onNavigateNext
  } = useClipNavigation({ index, generationIndex, allClips });

  const external = currentClip?.data.externalRender;
  const fal =
    external &&
    typeof external === "object" &&
    "provider" in external &&
    external.provider === "fal";
  const renderModel = fal
    ? "model" in external && typeof external.model === "string"
      ? `${external.model} (fal)`
      : "fal (direct)"
    : (allClips[index]?.data?.settings?.render_model as string | undefined);
  const inputStillId =
    fal && typeof currentClip?.data.source === "string"
      ? currentClip.data.source
      : inputImageId;
  const outputFilename = fal ? filename.replace(/\.jpg$/, ".png") : filename;
  const imageCrop = fal ? undefined : getImg2ImgClipCrop(allClips[index]);

  const isFirstSuccessfulRender =
    allClips.findIndex((clip) => clip.data.status === "success") === index;

  return (
    <div className="flex flex-col gap-2" id={`clip-${clipId}`}>
      <Img2ImgRenderHeader
        assetId={assetId}
        clipStatus={clipStatus}
        sourceFrame={sourceFrame}
        generationIndex={generationIndex}
        renderModel={renderModel}
      />

      <Img2ImgRenderImage
        assetId={assetId}
        clipStatus={clipStatus}
        filename={outputFilename}
        canNavigatePrev={canNavigatePrev}
        canNavigateNext={canNavigateNext}
        onNavigatePrev={onNavigatePrev}
        onNavigateNext={onNavigateNext}
        inputImageId={inputStillId}
        inputImageUrl={inputImageUrl}
        sourceFrame={sourceFrame}
        drawnMaskImageId={drawnMaskImageId}
        imageCrop={imageCrop}
      />

      <Img2ImgRenderActions
        index={index}
        disableIterate={disableIterate}
        assetId={assetId}
        clipId={clipId}
        clipStatus={clipStatus}
        sourceFrame={sourceFrame}
        filename={outputFilename}
        directFal={!!fal}
        isFirstSuccessfulRender={isFirstSuccessfulRender}
        imageCrop={imageCrop}
      />
    </div>
  );
};
