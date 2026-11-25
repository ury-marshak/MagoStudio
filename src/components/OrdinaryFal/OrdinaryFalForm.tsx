import { FalGenerationControls } from "@components/FalGenerationControls";
import { MainButton } from "@components/MainButton";
import { OrdinaryFalImagePicker } from "@components/OrdinaryFal/OrdinaryFalImagePicker";
import { useState } from "react";

import { readLocalFalImage } from "@/domains/ordinaryFal/localFalImages";
import {
  OrdinaryFalActionError,
  validateOrdinaryFalPrompt,
  type OrdinaryFalDraft
} from "@/domains/ordinaryFal/submitOrdinaryFal";
import { useOrdinaryFalAction } from "@/domains/ordinaryFal/useOrdinaryFalAction";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import {
  resolveFalGenerationSettings,
  type FalGenerationSettings
} from "../../../desktop/shared/falGenerationSettings";
import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3,
  isFalSheetModel,
  type FalSheetModel
} from "../../../desktop/shared/falSheetModel";
import {
  FAL_SHOT_ENGINE,
  FAL_SHOT_IMAGE_SLOTS
} from "../../../desktop/shared/falShotModel";

const imageModels = {
  [FAL_SHEET_MODEL]: "Nano Banana 2",
  [FAL_SHEET_MODEL_21]: "Nano Banana 2.1",
  [FAL_SHEET_MODEL_H3]: "MiniMax H3 Image"
};
const MIN_VIDEO_SECONDS = 5;
const MAX_VIDEO_SECONDS = 15;

type Destination<K extends OrdinaryFalDraft["kind"]> = Omit<
  Extract<OrdinaryFalDraft, { kind: K }>,
  | "kind"
  | "model"
  | "projectId"
  | "prompt"
  | "settings"
  | "referenceAssetIds"
  | "durationSeconds"
>;
type Props = { projectId?: string } & (
  | {
      kind: "image-edit";
      hasBaseImage: boolean;
      prepare: (check: () => void) => Promise<Destination<"image-edit">>;
    }
  | {
      kind: "reference-video";
      prepare: (check: () => void) => Promise<Destination<"reference-video">>;
    }
);

export const OrdinaryFalForm = (props: Props) => {
  const { kind, projectId } = props;
  const video = kind === "reference-video";
  const action = useOrdinaryFalAction(projectId);
  const { work } = useRendererLibraryWork();
  const [imageModel, setImageModel] = useState<FalSheetModel>(FAL_SHEET_MODEL);
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(String(MIN_VIDEO_SECONDS));
  const [references, setReferences] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [overrides, setOverrides] = useState<
    Record<string, FalGenerationSettings>
  >({});
  const model = video ? FAL_SHOT_ENGINE : imageModel;
  // These limits exclude the base still for image editing.
  const nanoExtraReferences = 13;
  const h3ExtraReferences = 15;
  const referenceLimit = video
    ? FAL_SHOT_IMAGE_SLOTS
    : imageModel === FAL_SHEET_MODEL_H3
      ? h3ExtraReferences
      : nanoExtraReferences;
  const durationSeconds = Number(duration);
  const validDuration =
    Number.isInteger(durationSeconds) &&
    durationSeconds >= MIN_VIDEO_SECONDS &&
    durationSeconds <= MAX_VIDEO_SECONDS;
  const inputMessage =
    references.length > referenceLimit
      ? `Select at most ${referenceLimit} reference images for this model.`
      : video && !references.length
        ? "Select at least one reference still."
        : props.kind === "image-edit" && !props.hasBaseImage
          ? "Select a base still first."
          : video && !validDuration
            ? "Choose a whole number of seconds from 5 to 15."
            : undefined;
  const settings = resolveFalGenerationSettings(
    model,
    overrides[model],
    action.projectDefaults?.[model],
    action.appDefaults?.[model]
  );

  const generate = () => {
    if (!projectId || importing || inputMessage || !prompt.trim()) return;
    void action.run(async (check) => {
      const trimmed = validateOrdinaryFalPrompt(prompt);
      if (new Set(references).size !== references.length)
        throw new OrdinaryFalActionError("Select distinct reference images.");
      const { assets } = getLocalDesktopApi();
      await Promise.all(
        references.map((assetId) =>
          readLocalFalImage({ assets, projectId, assetId, work, check })
        )
      );
      check();
      const common = {
        projectId,
        prompt: trimmed,
        settings: overrides[model],
        referenceAssetIds: references
      };
      if (props.kind === "reference-video") {
        return {
          ...common,
          ...(await props.prepare(check)),
          kind: "reference-video",
          model: FAL_SHOT_ENGINE,
          durationSeconds
        };
      }
      const destination = await props.prepare(check);
      if (references.includes(destination.baseAssetId))
        throw new OrdinaryFalActionError(
          "Remove the base still from the reference images."
        );
      return {
        ...common,
        ...destination,
        kind: "image-edit",
        model: imageModel
      };
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-glyph-secondary">
        Sends the selected images directly to fal and bills your fal account,
        not Mago credits.
        {video
          ? " Stills guide the video; they are not exact opening frames."
          : " Masks are not supported on this route."}
      </p>
      {video ? (
        <p className="text-sm">MiniMax H3 Max · Reference to video</p>
      ) : (
        <label className="flex flex-col gap-1 text-xs">
          fal model
          <select
            className="rounded-md border border-element-primary bg-transparent p-2"
            value={imageModel}
            onChange={(event) => {
              if (isFalSheetModel(event.target.value))
                setImageModel(event.target.value);
            }}
          >
            {Object.entries(imageModels).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs">
        Prompt
        <textarea
          className="rounded-md border border-element-primary bg-transparent p-2"
          rows={3}
          maxLength={20_000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <OrdinaryFalImagePicker
        projectId={projectId}
        onImportingChange={setImporting}
        text={video ? "Add reference stills" : "Add optional reference images"}
        value={references}
        onChange={setReferences}
        maxFileUpload={referenceLimit}
      />
      {video && (
        <label className="flex flex-col gap-1 text-xs">
          Duration (seconds)
          <input
            className="rounded-md border border-element-primary bg-transparent p-2"
            type="number"
            min={MIN_VIDEO_SECONDS}
            max={MAX_VIDEO_SECONDS}
            step={1}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </label>
      )}
      <FalGenerationControls
        model={model}
        settings={settings}
        disabled={action.busy}
        onChange={(next) =>
          setOverrides((previous) => ({ ...previous, [model]: next }))
        }
      />
      {(action.message || inputMessage) && (
        <p role="status" className="text-xs text-glyph-secondary">
          {action.message ?? inputMessage}
        </p>
      )}
      <MainButton
        type="button"
        loading={action.busy}
        isDisabled={
          action.disabled || importing || !!inputMessage || !prompt.trim()
        }
        onPress={generate}
      >
        Generate with fal
      </MainButton>
    </div>
  );
};
