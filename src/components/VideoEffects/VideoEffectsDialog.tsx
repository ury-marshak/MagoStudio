import { MainButton } from "@components/MainButton";
import { Modal } from "@components/Modal";
import { OrdinaryFalImagePicker } from "@components/OrdinaryFal/OrdinaryFalImagePicker";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  OrdinaryFalActionError,
  submitOrdinaryFal,
  validateOrdinaryFalPrompt
} from "@/domains/ordinaryFal/submitOrdinaryFal";
import { ordinaryFalJobsKey } from "@/domains/ordinaryFal/useOrdinaryFalAction";
import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import {
  FAL_KLING_EDIT,
  FAL_TOPAZ_UPSCALE,
  type OrdinaryFalAccount,
  type OrdinaryFalApi,
  type OrdinaryFalJob
} from "../../../desktop/shared/ordinaryFal";

import {
  useVideoEffectsHistory,
  videoEffectsHistoryKey
} from "./useVideoEffectsHistory";
import { VideoEffectsHistory } from "./VideoEffectsHistory";

const MAX_REFERENCES = 4;
const controlClassName =
  "rounded-md border border-element-primary bg-element-secondary p-2";

interface Props {
  bridge: OrdinaryFalApi;
  getConfig: () => Promise<OrdinaryFalAccount | null>;
  confirmedConfig: OrdinaryFalAccount;
  work: RendererLibraryWork;
  libraryVersion: number;
  owner: AbortSignal;
  projectId: string;
  shotId: string;
  clipId: string;
  assetId: string;
  assetName: string;
  trackName: string;
  onClose: () => void;
}

export const VideoEffectsDialog = ({
  bridge,
  getConfig,
  confirmedConfig,
  work,
  libraryVersion,
  owner,
  projectId,
  shotId,
  clipId,
  assetId,
  assetName,
  trackName,
  onClose
}: Props) => {
  const client = useQueryClient();
  const [effect, setEffect] = useState<"" | "video-edit" | "video-upscale">("");
  const [prompt, setPrompt] = useState("");
  const [keepAudio, setKeepAudio] = useState<"" | "keep" | "remove">("");
  const [references, setReferences] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<
    { job: OrdinaryFalJob } | { unconfirmedId: string }
  >();
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const { history, historyKey, validJob, refreshPlacement } =
    useVideoEffectsHistory({
      bridge,
      work,
      libraryVersion,
      owner,
      projectId,
      shotId
    });
  const delivered =
    attempt && "job" in attempt && validJob(attempt.job)
      ? attempt.job
      : undefined;
  const jobs = history.data ?? [];
  const visible =
    delivered && !jobs.some(({ id }) => id === delivered.id)
      ? [delivered, ...jobs]
      : jobs;
  const unconfirmed =
    attempt &&
    "unconfirmedId" in attempt &&
    !jobs.some(({ id }) => id === attempt.unconfirmedId);

  const canSubmit =
    confirmed &&
    !!effect &&
    !importing &&
    !busy &&
    !attempt &&
    (effect !== "video-edit" || (!!keepAudio && !!prompt.trim()));
  const submit = async () => {
    if (!canSubmit || pending.current || owner.aborted || work.signal.aborted)
      return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await submitOrdinaryFal({
        id: crypto.randomUUID(),
        work,
        profile: owner,
        bridge,
        localProject: true,
        config: getConfig,
        confirmedConfig,
        prepare: async () => {
          const source = {
            projectId,
            shotId,
            sourceClipId: clipId,
            expectedSourceAssetId: assetId
          };
          if (effect === "video-upscale")
            return { ...source, kind: effect, model: FAL_TOPAZ_UPSCALE };
          if (
            effect !== "video-edit" ||
            !keepAudio ||
            references.length > MAX_REFERENCES
          )
            throw new OrdinaryFalActionError(
              "Choose an effect, audio behavior, and up to four references."
            );
          return {
            ...source,
            kind: effect,
            model: FAL_KLING_EDIT,
            prompt: validateOrdinaryFalPrompt(prompt),
            keepAudio: keepAudio === "keep",
            ...(references.length ? { referenceAssetIds: [...references] } : {})
          };
        }
      });
      if (owner.aborted || work.signal.aborted) return;
      setAttempt(result);
      if ("job" in result && validJob(result.job))
        refreshPlacement([result.job]);
      void client.invalidateQueries({ queryKey: historyKey });
      void client.invalidateQueries({
        queryKey: libraryQueryKey(
          videoEffectsHistoryKey(projectId),
          libraryVersion
        )
      });
      void client.invalidateQueries({
        queryKey: libraryQueryKey(ordinaryFalJobsKey(projectId), libraryVersion)
      });
    } catch (cause) {
      if (owner.aborted || work.signal.aborted) return;
      pending.current = false;
      setError(
        cause instanceof OrdinaryFalActionError
          ? cause.message
          : "Could not prepare direct fal submission."
      );
    } finally {
      if (!owner.aborted && !work.signal.aborted) setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} width="sm" title="Video effects">
      <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-2 text-sm scrollbar-custom">
        <div>
          <p>
            Source: <strong>{assetName}</strong> on <strong>{trackName}</strong>
          </p>
          <p className="break-all text-xs text-glyph-secondary">
            Video asset ID: {assetId}
          </p>
          <p className="mt-2">
            The whole original video file, including any audio in it, is
            uploaded to fal, not just the visible range. Trimmed clips are not
            supported. The source and shot duration are unchanged.
          </p>
        </div>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy || !!attempt} className="space-y-3">
            <label className="flex flex-col gap-1">
              Effect
              <select
                className={controlClassName}
                value={effect}
                disabled={importing}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setEffect(
                    value === "video-edit" || value === "video-upscale"
                      ? value
                      : ""
                  );
                  setConfirmed(false);
                }}
              >
                <option value="">Choose a video effect</option>
                <option value="video-edit">Edit with Kling O1</option>
                <option value="video-upscale">Upscale with Topaz (2×)</option>
              </select>
            </label>
            {effect === "video-edit" && (
              <>
                <p className="text-glyph-secondary">
                  MP4 or MOV, 3–10 seconds, 720–2160 pixels on each side, 24–60
                  fps, up to 200 MB.
                </p>
                <label className="flex flex-col gap-1">
                  Edit prompt
                  <textarea
                    className={controlClassName}
                    value={prompt}
                    maxLength={20_000}
                    onChange={(event) => {
                      setPrompt(event.currentTarget.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  Output audio
                  <select
                    className={controlClassName}
                    value={keepAudio}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setKeepAudio(
                        value === "keep" || value === "remove" ? value : ""
                      );
                      setConfirmed(false);
                    }}
                  >
                    <option value="">Choose audio behavior</option>
                    <option value="keep">Request original audio</option>
                    <option value="remove">Request no audio</option>
                  </select>
                </label>
                <p>
                  Optional JPEG or PNG references are saved locally first and
                  sent in the order shown (up to four). Remove and re-add to
                  change the order.
                </p>
                {!busy && !attempt && (
                  <OrdinaryFalImagePicker
                    projectId={projectId}
                    text="Add local reference images"
                    value={references}
                    maxFileUpload={MAX_REFERENCES}
                    onImportingChange={(value) => {
                      if (owner.aborted || work.signal.aborted) return;
                      setImporting(value);
                      if (value) setConfirmed(false);
                    }}
                    onChange={(ids) => {
                      if (owner.aborted || work.signal.aborted) return;
                      setReferences(ids);
                      setConfirmed(false);
                    }}
                  />
                )}
              </>
            )}
            {effect === "video-upscale" && (
              <p className="text-glyph-secondary">
                Fixed Topaz Proteus 2× upscale, H.264 output, no frame-rate
                interpolation or audio settings. MP4 or MOV, up to 10 seconds,
                1920 × 1080 max (long × short edge), up to 200 MB.
              </p>
            )}
            <p className="text-glyph-secondary">
              Mask generation and masked edits, depth, pose, removal,
              character-motion transfer, and SDR-to-HDR are not supported.
              Direct fal never falls back to Mago or ComfyUI.
            </p>
            {effect && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  disabled={importing}
                  checked={confirmed}
                  onChange={(event) =>
                    setConfirmed(event.currentTarget.checked)
                  }
                />
                <span>
                  I agree to upload <strong>{assetName}</strong>
                  {effect === "video-edit"
                    ? " and send the prompt and any selected references"
                    : ""}{" "}
                  to fal. fal bills separately from Mago credits.
                </span>
              </label>
            )}
            <MainButton type="submit" isDisabled={!canSubmit} loading={busy}>
              Submit to fal
            </MainButton>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          {unconfirmed && (
            <p role="status">
              Submission could not be confirmed. Checking job{" "}
              {attempt.unconfirmedId}. Check fal history before sending this
              effect again.
            </p>
          )}
          <p className="text-xs text-glyph-secondary">
            Closing this dialog stops status checks, not a submitted fal job.
          </p>
        </form>
        <VideoEffectsHistory
          title="Video effects history for this shot"
          history={history}
          jobs={visible}
        />
      </div>
    </Modal>
  );
};
