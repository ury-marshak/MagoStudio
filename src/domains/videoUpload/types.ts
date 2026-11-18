import { VideoAssetCreationData } from "@hooks/assets/interface";
import { TrimMetadata } from "@schemas/video";

import { VideoAssetResponse } from "../asset/interface";

export type IngestPhase = "creating" | "uploading" | "ingesting" | "finalizing";

export interface IngestProgressEvent {
  phase: IngestPhase;
  progress: number;
}

interface IngestedTrackInfo {
  trackId: string;
  trackName: string;
}

export interface IngestVideoParams {
  shotId: string;
  projectId: string;
  file: File;
  trimMetadata?: TrimMetadata;
  signal?: AbortSignal;
  awaitInvalidation?: boolean;
  onProgress?: (event: IngestProgressEvent) => void;
  onUploaded?: (info: IngestedTrackInfo) => void;
}

export interface IngestVideoDeps {
  createVideoAsset: (params: {
    file: File;
    shotId: string;
    signal: AbortSignal;
  }) => Promise<VideoAssetCreationData>;
  uploadAssetToS3: (params: {
    s3_url: string;
    file: File;
    onUploadProgress?: (progress: number) => void;
    signal: AbortSignal;
  }) => Promise<void>;
  publishIngestionJob: (
    assetId: string,
    signal: AbortSignal
  ) => Promise<unknown>;
  fetchVideoAssetStatus: (
    assetId: string,
    signal: AbortSignal
  ) => Promise<VideoAssetResponse | undefined>;
  invalidateAfterIngest: (
    projectId: string,
    signal: AbortSignal
  ) => Promise<void>;
  cacheVideoFile: (assetId: string, file: File) => Promise<void>;
  waitForPollTick: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type IngestVideoResult =
  | { outcome: "ingested"; assetId: string; trackId: string }
  | { outcome: "cancelled" };
