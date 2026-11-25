import type { FalGenerationSettings } from "./falGenerationSettings";
import type { FalSheetModel } from "./falSheetModel";
import type { FAL_SHOT_ENGINE } from "./falShotModel";

export const FAL_KLING_EDIT = "fal_kling_o1_edit";
export const FAL_TOPAZ_UPSCALE = "fal_topaz_video_upscale";

interface OrdinaryFalDestination {
  /** Retain the same UUID if the submit IPC response was lost. */
  id: string;
  projectId: string;
  shotId: string;
}

type OrdinaryFalGeneration = OrdinaryFalDestination & {
  prompt: string;
  referenceAssetIds?: string[];
  settings?: FalGenerationSettings;
} & (
    | {
        kind: "image-edit";
        model: FalSheetModel;
        baseAssetId: string;
        frame: number;
        canvas: { width: number; height: number };
      }
    | {
        kind: "reference-video";
        model: typeof FAL_SHOT_ENGINE;
        referenceAssetIds: string[];
        trackId: string;
        timelineOffsetMs: number;
        durationSeconds: number;
      }
  );

export type OrdinaryFalEffectInput = OrdinaryFalDestination & {
  sourceClipId: string;
  expectedSourceAssetId: string;
} & (
    | {
        kind: "video-edit";
        model: typeof FAL_KLING_EDIT;
        prompt: string;
        keepAudio: boolean;
        referenceAssetIds?: string[];
      }
    | { kind: "video-upscale"; model: typeof FAL_TOPAZ_UPSCALE }
  );
export type OrdinaryFalSubmitInput =
  | OrdinaryFalGeneration
  | OrdinaryFalEffectInput;

export type OrdinaryFalEffectDestination = {
  kind: OrdinaryFalEffectInput["kind"];
  sourceClipId: string;
  sourceAssetId: string;
  sourceTrackId: string;
  startFrame: number;
  frameCount: number;
  source: {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
    sizeBytes: number;
    /** Absent on older jobs; only verified presentation timing can be placed. */
    presentationSignature?: string;
  };
};

export interface OrdinaryFalJob extends OrdinaryFalDestination {
  kind: OrdinaryFalSubmitInput["kind"];
  model: OrdinaryFalSubmitInput["model"];
  status:
    | "PREPARING"
    | "NOT_SUBMITTED"
    | "SUBMITTING"
    | "SUBMISSION_UNKNOWN"
    | "SUBMITTED"
    | "CANCELLATION_REQUESTED"
    | "CANCELLED"
    | "FAILED"
    | "COMPLETED"
    | "INGESTED";
  placement: "PENDING" | "ATTACHED" | "UNATTACHED";
  assetIds: string[];
  clipId: string | null;
  error: string | null;
  warning?: string;
}

/** Non-secret metadata that binds a confirmed request to the saved fal config. */
export type OrdinaryFalAccount = { keychainAccount: string; revision: string };

export type OrdinaryFalSubmitRequest = {
  request: OrdinaryFalSubmitInput;
  expectedFal: OrdinaryFalAccount;
};

/** A rejection is definite. A failed IPC invocation is not a rejection reply. */
export type OrdinaryFalSubmitResult =
  | { status: "job"; job: OrdinaryFalJob }
  | { status: "rejected"; message: string };

export interface OrdinaryFalApi {
  submit(input: OrdinaryFalSubmitRequest): Promise<OrdinaryFalSubmitResult>;
  get(input: { id: string }): Promise<OrdinaryFalJob | null>;
  list(input?: { projectId?: string }): Promise<OrdinaryFalJob[]>;
}
