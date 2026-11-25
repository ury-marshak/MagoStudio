import { useFalProviderConfig } from "@domains/scriptProject/useFalProviderConfigured";
import { useSelectedShotId } from "@domains/shot/useSelectedShotId";
import { getTrackClip } from "@domains/track/utils/getTrackClip";
import { AssetType } from "@schemas/asset";
import type { Layer } from "@schemas/layer";
import type { Project } from "@schemas/project";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { isLocalApp } from "@/platform/localDesktop";

import { useVideoEffectsScope } from "./useVideoEffectsScope";
import { VideoEffectsDialog } from "./VideoEffectsDialog";

export const VIDEO_EFFECTS_LABEL = "Video effects…";

export const useVideoEffects = (
  project: Project | undefined,
  track: Layer,
  excluded = false
) => {
  const { work, libraryVersion, profile, retired } = useVideoEffectsScope();
  const { selectedShotId } = useSelectedShotId();
  const desktop =
    isLocalApp && typeof window !== "undefined" ? window.mago : undefined;
  const bridge = desktop?.ordinaryFal;
  const getConfig = desktop?.externalProviders?.fal?.get;
  const clip = getTrackClip(track);
  const asset = clip?.asset;
  const eligible =
    !excluded &&
    !!bridge &&
    !!getConfig &&
    !retired &&
    !work.signal.aborted &&
    project?.origin === "local" &&
    project.type === "timeline" &&
    project.active &&
    track.project_id === project.id &&
    track.active &&
    track.clips.length === 1 &&
    asset?.type === AssetType.VIDEO &&
    asset.data.status === "ingested" &&
    clip?.asset_id === asset.id &&
    !!asset.project_ids?.includes(project.id);
  const config = useFalProviderConfig(!!eligible);
  const confirmedConfig = !config.isError ? config.data : undefined;
  const identity = JSON.stringify([
    eligible && project.id,
    selectedShotId,
    track.timeline_id,
    track.id,
    clip?.id,
    asset?.id,
    asset?.name,
    clip?.data?.duration,
    clip?.data?.timeline_offset,
    clip?.data?.frame_range,
    confirmedConfig?.keychainAccount,
    confirmedConfig?.revision
  ]);
  const origin = useMemo(
    () => ({ identity, work, profile }),
    [identity, work, profile]
  );
  const committed = useRef<typeof origin | null>(null);
  const currentDialog = useRef<AbortController | null>(null);
  const [opened, setOpened] = useState<{
    origin: typeof origin;
    controller: AbortController;
    owner: AbortSignal;
  }>();
  // Retire both old menu callbacks and in-flight confirmation work on a row,
  // shot, project or library change, including when IDs are reused.
  // oxlint-disable-next-line custom-react/no-use-layout-effect -- guard IPC callbacks at commit/unmount
  useLayoutEffect(() => {
    committed.current = origin;
    return () => {
      committed.current = null;
      currentDialog.current?.abort();
      currentDialog.current = null;
    };
  }, [origin]);
  const available = !!(eligible && confirmedConfig);
  const open = () => {
    if (
      !available ||
      committed.current !== origin ||
      currentDialog.current ||
      work.signal.aborted ||
      profile?.aborted
    )
      return;
    const controller = new AbortController();
    currentDialog.current = controller;
    const owner = profile
      ? AbortSignal.any([profile, controller.signal])
      : controller.signal;
    setOpened({ origin, controller, owner });
  };
  const dialog =
    available &&
    opened?.origin === origin &&
    project &&
    clip &&
    asset &&
    bridge &&
    confirmedConfig ? (
      <VideoEffectsDialog
        bridge={bridge}
        getConfig={getConfig}
        confirmedConfig={confirmedConfig}
        work={work}
        libraryVersion={libraryVersion}
        owner={opened.owner}
        projectId={project.id}
        shotId={track.timeline_id}
        clipId={clip.id}
        assetId={asset.id}
        assetName={asset.name}
        trackName={track.name}
        onClose={() => {
          if (currentDialog.current !== opened.controller) return;
          opened.controller.abort();
          currentDialog.current = null;
          setOpened(undefined);
        }}
      />
    ) : null;
  return { available, open, dialog };
};
