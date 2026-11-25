import { GhostButton } from "@components/GhostButton";
import { Tooltip } from "@components/Tooltip";
import { getImageAsset } from "@domains/asset/getImageAsset";
import React, { useState } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { releaseRendererObjectUrl } from "@/platform/rendererObjectUrl";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { useGetImg2ImgRenderStatus } from "../hooks/useGetImg2ImgRenderStatus";
import { Img2ImgType, ModelSchemaMap } from "../schemas";

import { createFileFromImageData } from "./helpers/createFileFromImageData";
import { parseSettingsToImg2ImgForm } from "./helpers/parseSettingsToImg2ImgForm";

type Props = {
  clipId: string;
  isDisabled?: boolean;
};

const isRemovedModel = (renderModel: string | undefined): boolean =>
  !!renderModel && !(renderModel in ModelSchemaMap);

const HIDDEN_REUSE_MODELS = ["mago"];
const isHiddenReuseModel = (renderModel: string | undefined): boolean =>
  !!renderModel && HIDDEN_REUSE_MODELS.includes(renderModel);

export const TweakButton: React.FC<Props> = ({
  clipId,
  isDisabled = false
}) => {
  const { t } = useTranslation();
  const { data: renderItemStatusResponse, refetch: refetchStatus } =
    useGetImg2ImgRenderStatus({
      clipId
    });
  const { work, libraryVersion } = useRendererLibraryWork();
  const [loadingVersion, setLoadingVersion] = useState<number>();
  const isLoading = loadingVersion === libraryVersion;
  const { reset } = useFormContext<Img2ImgType>();

  const renderModel = renderItemStatusResponse?.data?.settings?.render_model;

  if (isHiddenReuseModel(renderModel)) {
    return null;
  }

  const showDisabledForRemovedModel = isRemovedModel(renderModel);

  const handleTweakIt = async () => {
    if (work.signal.aborted) return;
    setLoadingVersion(libraryVersion);
    try {
      await work.ready();
      work.check();
      let renderSettings = renderItemStatusResponse?.data?.settings;

      if (!renderSettings) {
        const result = await refetchStatus();
        work.check();
        renderSettings = result.data?.data?.settings;
      }

      if (!renderSettings) {
        console.warn("No render settings available for clip:", clipId);
        return;
      }

      if (isRemovedModel(renderSettings.render_model)) {
        return;
      }

      let inputImage = {};
      if (renderSettings.input_image_id) {
        const image = await getImageAsset(renderSettings.input_image_id, work);
        if (image) {
          try {
            work.check();
            const imageFile = await createFileFromImageData(image, work);
            inputImage = {
              frameImage: [imageFile],
              frameType: "upload",
              uploadedImageId: renderSettings.input_image_id
            };
          } finally {
            if (image.urlToUse) releaseRendererObjectUrl(image.urlToUse);
          }
        }
      }

      work.check();
      reset(parseSettingsToImg2ImgForm(renderSettings, inputImage));
    } catch (error) {
      if (!work.signal.aborted)
        console.error("Failed to load settings:", error);
    } finally {
      if (!work.signal.aborted) setLoadingVersion(undefined);
    }
  };

  const removedModelTooltip = t(
    "buttonTooltips.tweak_it_button.disabledTooltip"
  );

  const button = (
    <GhostButton
      onPress={handleTweakIt}
      aria-label={
        showDisabledForRemovedModel
          ? removedModelTooltip
          : "Reuse the stylized image settings"
      }
      loading={isLoading}
      isDisabled={isDisabled || showDisabledForRemovedModel}
    >
      {t("actions.tweak_it.label")}
    </GhostButton>
  );

  if (showDisabledForRemovedModel) {
    return (
      <Tooltip
        placement="top"
        textContent={removedModelTooltip}
        trigger={button}
      />
    );
  }

  return button;
};
