import { Layer, LayerType } from "@schemas/layer";
import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { postTrack, PostTrackParams } from "../api/postLayer";

const PARENT_VIDEO_TRACK_ORDER = 1;

export const usePostTrack = ({
  selectedProjectId,
  parentVideoTrackId
}: {
  selectedProjectId?: string;
  parentVideoTrackId?: string;
}) => {
  const queryClient = useQueryClient();
  const onSuccess = (newTrack: Layer, variables: PostTrackParams) => {
    queryClient.setQueryData(
      libraryQueryKey(queryKeys.project.byId(selectedProjectId)),
      (project: Project) => {
        if (!project) {
          return project;
        }
        if (!variables.shotId) {
          return project;
        }
        return {
          ...project,
          timelines: project.timelines?.map((shot) => {
            if (shot.id === variables.shotId) {
              return {
                ...shot,
                layers: [
                  ...shot.layers.map((layer) => {
                    if (
                      layer.type.toUpperCase() ===
                      LayerType.RENDER.toUpperCase()
                    ) {
                      return {
                        ...layer,
                        layer_order: layer.layer_order + 1
                      };
                    }
                    if (layer.id === parentVideoTrackId) {
                      return {
                        ...layer,
                        layer_order: PARENT_VIDEO_TRACK_ORDER
                      };
                    }
                    return layer;
                  }),
                  newTrack
                ]
              };
            }
            return shot;
          })
        };
      }
    );
  };
  return useRendererLibraryMutation({
    mutationFn: (params: PostTrackParams, work) =>
      postTrack(params, selectedProjectId, work),
    onSuccess
  });
};
