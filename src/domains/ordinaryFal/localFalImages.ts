import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import type { MagoDesktopApi } from "../../../desktop/shared/contracts";

import { OrdinaryFalActionError } from "./submitOrdinaryFal";

type Assets = Pick<MagoDesktopApi["assets"], "get" | "importImage">;
const MAX_CANVAS_EDGE = 16_384;

export const ordinaryFalCanvas = (width: unknown, height: unknown) => {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![width, height].every(
      (edge) => Number.isInteger(edge) && edge >= 1 && edge <= MAX_CANVAS_EDGE
    )
  ) {
    throw new OrdinaryFalActionError("The base still has invalid dimensions.");
  }
  return { width, height };
};

export const readLocalFalImage = async ({
  assets,
  projectId,
  assetId,
  work,
  check
}: {
  assets: Pick<Assets, "get">;
  projectId: string;
  assetId: string;
  work: RendererLibraryWork;
  check: () => void;
}) => {
  const asset = await work.boundary(() => {
    check();
    return assets.get(assetId);
  });
  check();
  if (
    !asset ||
    asset.type !== "IMAGE" ||
    asset.data.status !== "ingested" ||
    !Array.isArray(asset.project_ids) ||
    !asset.project_ids.includes(projectId)
  ) {
    throw new OrdinaryFalActionError(
      "Select images available locally in this project."
    );
  }
  return asset;
};

export const importLocalFalStill = async ({
  assets,
  projectId,
  dataUrl,
  frame,
  file,
  work,
  check
}: {
  assets: Pick<Assets, "importImage">;
  projectId: string;
  dataUrl: string;
  frame?: number;
  file?: File;
  work: RendererLibraryWork;
  check: () => void;
}) => {
  check();
  // Only accept a prepared local image, never a remote URL or file path.
  const match = /^data:image\/(jpeg|png);base64,/.exec(dataUrl);
  if (!match)
    throw new OrdinaryFalActionError("Select a local JPEG or PNG still.");
  const blob =
    file ?? (await (await fetch(dataUrl, { signal: work.signal })).blob());
  check();
  const bitmap = await createImageBitmap(blob);
  try {
    check();
    const canvas = ordinaryFalCanvas(bitmap.width, bitmap.height);
    const image = await work.boundary(() => {
      check();
      return assets.importImage({
        projectId,
        dataUrl,
        ...canvas,
        name:
          file?.name ?? `Frame ${frame}.${match[1] === "jpeg" ? "jpg" : "png"}`
      });
    });
    check();
    return { baseAssetId: image.id, canvas };
  } finally {
    bitmap.close();
  }
};
