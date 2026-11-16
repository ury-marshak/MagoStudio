import { mediaDownloads } from "@domains/asset/mediaDownloads";
/* oxlint-disable custom-react/no-use-effect -- cloud mirroring is an external synchronization process */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import {
  deferCloudProjectCatalogSync,
  getCloudProjectSyncStatus,
  promoteCloudTimeline,
  subscribeCloudAssetReady,
  subscribeCloudProjectMetadata,
  subscribeCloudProjectSyncStatus,
  syncCloudProject,
  syncCloudScriptProjects
} from "./syncCloudScriptProjects";

const ASSET_REFRESH_DEBOUNCE_MS = 250;

export const useCloudProjectSync = (
  projectId?: string,
  timelineId?: string
): { isSyncing: boolean } => {
  const queryClient = useQueryClient();
  const { work } = useRendererLibraryWork();
  const isSyncing = useSyncExternalStore(
    subscribeCloudProjectSyncStatus,
    getCloudProjectSyncStatus,
    getCloudProjectSyncStatus
  );

  useEffect(() => {
    if (getLocalDesktopApi().account.mode !== "cloud" || work.signal.aborted)
      return;
    const invalidate = (queryKey: readonly unknown[]) => {
      if (!work.signal.aborted)
        return queryClient.invalidateQueries({ queryKey });
    };
    return subscribeCloudAssetReady((_readyProjectId, assetId) => {
      if (work.signal.aborted) return;
      void invalidate(queryKeys.videoAsset.byId(assetId));
      void invalidate(queryKeys.imageAsset.byId(assetId));
      void invalidate(["frame-generate", assetId]);
      void invalidate(["cached-video-preview", assetId]);
    });
  }, [queryClient, work]);

  useEffect(() => {
    const desktop = getLocalDesktopApi();
    if (desktop.account.mode !== "cloud" || work.signal.aborted) return;
    let isActive = true;
    const invalidate = (queryKey: readonly unknown[]) => {
      if (isActive && !work.signal.aborted)
        return queryClient.invalidateQueries({ queryKey });
    };
    let catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refreshProjectDetails = async (metadataProjectId: string) => {
      if (!isActive || work.signal.aborted || metadataProjectId !== projectId)
        return;
      await Promise.all([
        invalidate(queryKeys.project.byId(metadataProjectId)),
        invalidate(queryKeys.timelineList.byProjectId(metadataProjectId)),
        invalidate(queryKeys.projectState.byProjectId(metadataProjectId)),
        invalidate(
          queryKeys.projectScriptVersions.byProjectId(metadataProjectId)
        ),
        invalidate(queryKeys.projectCut.byProjectId(metadataProjectId))
      ]);
    };
    const unsubscribeMetadata = subscribeCloudProjectMetadata((syncedId) => {
      if (!isActive || work.signal.aborted) return;
      void refreshProjectDetails(syncedId);
      if (!projectId && !catalogRefreshTimer) {
        catalogRefreshTimer = setTimeout(() => {
          catalogRefreshTimer = null;
          if (!isActive || work.signal.aborted) return;
          void invalidate(queryKeys.homepage.all);
          void invalidate(queryKeys.projectList.all);
          void invalidate(queryKeys.projects.all);
        }, ASSET_REFRESH_DEBOUNCE_MS);
      }
    });

    // Media lands one asset at a time. Coalesce a burst of arrivals into one
    // project refresh, but refresh that asset's own queries straight away so
    // its player and thumbnails stop waiting.
    let projectRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeAssetReady = subscribeCloudAssetReady((readyProjectId) => {
      if (!isActive || work.signal.aborted || readyProjectId !== projectId)
        return;
      if (projectRefreshTimer) return;
      projectRefreshTimer = setTimeout(() => {
        projectRefreshTimer = null;
        void refreshProjectDetails(readyProjectId);
      }, ASSET_REFRESH_DEBOUNCE_MS);
    });

    const refreshCatalog = async () => {
      await syncCloudScriptProjects(work);
      if (!isActive || work.signal.aborted) return;
      await Promise.all([
        invalidate(queryKeys.projectList.all),
        invalidate(queryKeys.projects.all),
        invalidate(queryKeys.homepage.all)
      ]);
    };

    const refresh = async () => {
      if (!projectId) {
        // The homepage query reads the durable local catalog itself. Start the
        // cloud refresh afterward without making rendering or navigation await
        // it.
        await refreshCatalog();
        return;
      }

      // Project routes read only the selected row. In particular, opening a
      // local-origin project must neither await the global catalog sync nor
      // invalidate and reload the project that is already on disk.
      deferCloudProjectCatalogSync(work);
      const localProject = await work.boundary(() =>
        desktop.projects.get(projectId)
      );
      if (!isActive || work.signal.aborted || localProject?.origin === "local")
        return;

      // A cloud-origin (or not-yet-cached) project remains usable from its local
      // snapshot while its detail refresh proceeds independently.
      void syncCloudProject(projectId, undefined, work).catch((error) => {
        if (isActive && !work.signal.aborted) {
          console.warn(`Failed to refresh cloud project ${projectId}`, error);
        }
      });
    };

    void refresh().catch((error) => {
      if (isActive && !work.signal.aborted)
        console.warn("Failed to refresh cloud projects", error);
    });
    return () => {
      isActive = false;
      unsubscribeMetadata();
      unsubscribeAssetReady();
      if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
      if (catalogRefreshTimer) clearTimeout(catalogRefreshTimer);
      // Navigation demotes the old project; its media continues in idle slots.
    };
  }, [projectId, queryClient, work]);

  // The opened Shot's media is fetched first. This runs after the effect above
  // in the same commit, and that effect's sync starts asynchronously, so the
  // priority is already set when the first download is chosen.
  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- priority hint for an external download queue */
  useEffect(() => {
    if (work.signal.aborted) return;
    mediaDownloads.setForeground(projectId, timelineId);
    if (timelineId) promoteCloudTimeline(timelineId);
  }, [projectId, timelineId, work]);
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  return { isSyncing };
};
