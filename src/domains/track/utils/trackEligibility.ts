import { Layer, LayerType } from "@schemas/layer";

const MAGO_V2_ENGINE = "magov2";

const isFalEffectRender = (external: unknown): boolean =>
  !!external &&
  typeof external === "object" &&
  "provider" in external &&
  external.provider === "fal" &&
  "kind" in external &&
  (external.kind === "video-edit" || external.kind === "video-upscale");

export const isEligibleRenderTrack = (track: Layer): boolean => {
  if (track.type !== LayerType.RENDER || !track.clips.length) return false;
  return (
    track.data.renderEngine === MAGO_V2_ENGINE ||
    isFalEffectRender(track.data.externalRender)
  );
};

export const filterEligibleLayers = (layers: Layer[]): Layer[] =>
  layers.filter(
    (layer) => layer.type !== LayerType.RENDER || isEligibleRenderTrack(layer)
  );
