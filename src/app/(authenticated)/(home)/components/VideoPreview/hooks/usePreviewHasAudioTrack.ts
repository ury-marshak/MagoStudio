import { detectVideoHasAudioTrack } from "@app/services/mediaBunny/detectVideoHasAudioTrack";
import { useSelectedTrackIds } from "@domains/track/useSelectedTrackIds";
import { currentVideoSrcAtom } from "@store/atoms";
import { useQueries } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

export const usePreviewHasAudioTrack = () => {
  const currentVideoSrc = useAtomValue(currentVideoSrcAtom);
  const previewedTrackIds = useSelectedTrackIds();
  const { work, libraryVersion } = useRendererLibraryWork();

  const videoSrcs = work.signal.aborted
    ? []
    : [
        ...new Set(
          previewedTrackIds.flatMap((trackId) => {
            const source = currentVideoSrc[trackId];
            return source?.signal === work.signal ? [source.url] : [];
          })
        )
      ];

  const results = useQueries({
    queries: videoSrcs.map((videoSrc) => ({
      queryKey: [
        ...queryKeys.videoHasAudioTrack.bySrc(videoSrc),
        libraryVersion
      ],
      queryFn: () => detectVideoHasAudioTrack(videoSrc, work),
      staleTime: Infinity,
      retry: false
    }))
  });

  const isResolved = videoSrcs.length > 0 && results.every((r) => r.isSuccess);
  const hasAudioTrack = isResolved
    ? results.some((r) => r.data === true)
    : true;

  return { hasAudioTrack, isResolved };
};
