import { MainButton } from "@components/MainButton";
import { Modal } from "@components/Modal";
import { useProject } from "@domains/project/useProject";
import { useState } from "react";

import { isLocalApp } from "@/platform/localDesktop";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import type { OrdinaryFalApi } from "../../../desktop/shared/ordinaryFal";

import { useVideoEffectsHistory } from "./useVideoEffectsHistory";
import { useVideoEffectsScope } from "./useVideoEffectsScope";
import { VideoEffectsHistory } from "./VideoEffectsHistory";

interface HistoryProps {
  bridge: Pick<OrdinaryFalApi, "list">;
  projectId: string;
  libraryVersion: number;
  work: RendererLibraryWork;
  owner?: AbortSignal;
}

const HistoryDialog = ({
  onClose,
  ...props
}: HistoryProps & { onClose: () => void }) => {
  const { history } = useVideoEffectsHistory(props);
  return (
    <Modal open onClose={onClose} width="sm" title="Video effects history">
      <div className="max-h-[65vh] overflow-y-auto pr-2 text-sm scrollbar-custom">
        <VideoEffectsHistory
          title="Video effects history for this project"
          history={history}
          jobs={history.data ?? []}
          showAttachedResults
        />
      </div>
    </Modal>
  );
};

const HistoryButton = (props: HistoryProps) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MainButton
        size="sm"
        colorScheme="secondary"
        onPress={() => setOpen(true)}
      >
        Video effects history
      </MainButton>
      {open && <HistoryDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
};

const LocalProjectHistory = ({
  bridge,
  projectId
}: Pick<HistoryProps, "bridge" | "projectId">) => {
  const { data: project } = useProject(projectId);
  const { work, libraryVersion, profile, retired } = useVideoEffectsScope();
  if (
    retired ||
    work.signal.aborted ||
    project?.origin !== "local" ||
    project.type !== "timeline" ||
    !project.active
  )
    return null;
  return (
    <HistoryButton
      key={JSON.stringify([libraryVersion, projectId])}
      bridge={bridge}
      projectId={projectId}
      work={work}
      libraryVersion={libraryVersion}
      owner={profile}
    />
  );
};

export const VideoEffectsHistoryButton = ({
  projectId
}: {
  projectId: string;
}) => {
  const bridge =
    isLocalApp && typeof window !== "undefined"
      ? window.mago?.ordinaryFal
      : undefined;
  return bridge?.list ? (
    <LocalProjectHistory projectId={projectId} bridge={bridge} />
  ) : null;
};
