import { Badge } from "@components/Badge";
import { Icon } from "@components/Icon";
import { IconActionButton } from "@components/IconActionButton";
import { Tooltip } from "@components/Tooltip";
import {
  VIDEO_EFFECTS_LABEL,
  useVideoEffects
} from "@components/VideoEffects/useVideoEffects";
import { useProject } from "@domains/project/useProject";
import { useSelectedProjectId } from "@domains/project/useSelectedProjectId";
import { useGoBackToSourceVideo } from "@domains/track/useGoBackToSourceVideo";
import { useSelectedTrackIds } from "@domains/track/useSelectedTrackIds";
import { Layer } from "@schemas/layer";
import { useInputTrackIdAtom } from "@store/atoms";
import { cn } from "@utils";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";

import { LayerPreview } from "../RenderTrackItem/LayerPreview";

interface Props {
  track: Layer;
}

export const InputVideoTrackItem: React.FC<Props> = ({ track }) => {
  const { t } = useTranslation();

  const selectedTrackIds = useSelectedTrackIds();
  const isTrackSelected = selectedTrackIds.includes(track.id);

  const projectId = useSelectedProjectId();
  const { data: project } = useProject(projectId);
  const shot = project?.timelines?.find((t) => t.id === track.timeline_id);

  const inputTrackIdAtom = useInputTrackIdAtom();
  const inputTrackId = useAtomValue(inputTrackIdAtom);
  const isInputTrack = inputTrackId === track.id;
  const displayName = shot?.name ?? track.name;

  const goBackToSourceVideo = useGoBackToSourceVideo();
  const effects = useVideoEffects(project, track);

  return (
    <div className="relative h-full w-full">
      <div className="relative flex mb-3 bg-element-tertiary border-r-4 border-r-transparent">
        <div
          className={cn(
            "relative h-20 flex justify-around items-center px-1 border-l-2 w-full",
            isTrackSelected
              ? "border-l-glyph-action-main"
              : "border-l-transparent"
          )}
        >
          {isInputTrack && (
            <Icon
              iconSet="16-technical"
              iconName="video"
              className="absolute top-1 left-2 text-code-200"
            />
          )}
          {/* Preserve the legacy button alignment when effects are unavailable. */}
          {effects.available ? (
            <button
              type="button"
              className="text-xs text-glyph-primary hover:underline"
              onClick={effects.open}
            >
              {VIDEO_EFFECTS_LABEL}
            </button>
          ) : (
            <>
              <div aria-hidden className="size-6" />
              <div aria-hidden className="size-6" />
            </>
          )}
          <Tooltip
            textContent={t("actions.go_back_to_source_video.label")}
            placement="top"
          >
            <IconActionButton
              aria-label={t("actions.go_back_to_source_video.label")}
              icon={<Icon iconSet="16" iconName="edit-video" />}
              onPress={goBackToSourceVideo}
            />
          </Tooltip>
        </div>
        <div
          className="flex flex-col w-full relative"
          data-onboarding-id="pf-video-track"
        >
          <LayerPreview track={track} />
          <div className="absolute bottom-1.5 left-6 z-10">
            <Badge>{displayName}</Badge>
          </div>
        </div>
      </div>
      {effects.dialog}
    </div>
  );
};
