import { isRenderCancelable } from "@domains/queue/utils/isRenderCancelable";
import { AssetStatus } from "@schemas/asset";
import {
  useQuery,
  UseQueryResult,
  Query,
  useQueryClient
} from "@tanstack/react-query";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import { captureRendererCloudAccountScope } from "@/platform/rendererCloudAccountScope";
import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { QueueItem } from "./interface";
import { attachCloudQueueRow } from "./utils/attachCloudQueueRow";
import { countQueueItemsByStatus } from "./utils/countQueueItemsByStatus";
import { findCloudQueueRowForAsset } from "./utils/findCloudQueueRowForAsset";
import { isCloudQueueItemCancelable } from "./utils/isCloudQueueItemCancelable";

async function fetchFilteredQueue(): Promise<QueueItem[]> {
  const response = await backendApiClient.get<QueueItem[]>(`/queue`);
  return response.data.map((item) => ({
    ...item,
    render_provider: "mago-cloud" as const
  }));
}

/**
 * Cloud renders, presented as entries in this app's own queue.
 *
 * Without this a cloud render sits at PENDING with no progress, position or ETA,
 * because the desktop queue only knows about renders running on this machine.
 * The cloud queue has all of it; the ids just need swapping for local ones.
 */
async function fetchCloudQueue(
  work: RendererLibraryWork,
  cloud: ReturnType<typeof captureRendererCloudAccountScope>
): Promise<QueueItem[]> {
  work.check();
  const localHistory = (
    (await getLocalDesktopApi().cloud.renders.listQueue()) as unknown as QueueItem[]
  ).map((item) => ({ ...item, local_cloud_render_job_id: item.id }));
  work.check();
  if (!cloud.isActive()) return localHistory;
  try {
    const signal = cloud.signal
      ? AbortSignal.any([work.signal, cloud.signal])
      : work.signal;
    const response = await backendApiClient.get<unknown>(`/queue`, { signal });
    work.check();
    if (!cloud.isActive()) return localHistory;
    const remoteRows = Array.isArray(response.data)
      ? response.data
      : Array.isArray((response.data as { items?: unknown })?.items)
        ? (response.data as { items: unknown[] }).items
        : [];
    const trackedCloudAssetIds = new Set(
      localHistory.flatMap((item) =>
        item.cloud_asset_id ? [item.cloud_asset_id] : []
      )
    );
    const backendOnlyQueue = remoteRows
      .filter((item) => {
        const assetId = (item as { asset_id?: unknown }).asset_id;
        return (
          typeof assetId !== "string" || !trackedCloudAssetIds.has(assetId)
        );
      })
      .map(
        (item) =>
          ({
            ...(item as QueueItem),
            render_provider: "mago-cloud"
          }) satisfies QueueItem
      );
    const localHistoryWithCloudQueueRows = localHistory.map((item) =>
      attachCloudQueueRow(
        item,
        item.cloud_asset_id
          ? findCloudQueueRowForAsset(remoteRows, item.cloud_asset_id)
          : null
      )
    );
    return [...localHistoryWithCloudQueueRows, ...backendOnlyQueue];
  } catch {
    work.check();
    // Persisted mirrored jobs remain visible even when cloud is temporarily
    // unreachable. Backend-only script-shot jobs return on the next refresh.
    return localHistory;
  }
}

type UseQueueResult = UseQueryResult<QueueItem[], Error> & {
  triggerRefetch: () => void;
};

const POLL_INTERVAL = parseInt(process.env.QUEUE_POLL_INTERVAL || "5000");

const queueRefetchInterval = (
  queryState: Query<QueueItem[], Error>,
  projectId?: string
) => {
  const queueItems = queryState.state.data;

  const filteredQueueItems = projectId
    ? queueItems?.filter((item: QueueItem) => item.project_id === projectId)
    : queueItems;

  const hasInProgressItems = filteredQueueItems?.some(
    (item: QueueItem) =>
      item.status === AssetStatus.INPROGRESS ||
      item.status === AssetStatus.PENDING ||
      item.status === AssetStatus.INQUEUE
  );

  return hasInProgressItems ? POLL_INTERVAL : false;
};

const select = (data: QueueItem[]) => {
  return data.map((item: QueueItem) => ({
    ...item,
    isCancelable:
      item.render_provider === "mago-cloud"
        ? isCloudQueueItemCancelable(item)
        : isRenderCancelable({
            status: item.status,
            positionInQueue: item.display_order
          })
  }));
};

export function useQueue(props?: { enabled?: boolean }): UseQueueResult {
  const enabled = props?.enabled ?? true;
  const queryClient = useQueryClient();
  const scope = useRendererLibraryQueryScope();
  const queryKey = scope.key(queryKeys.queue.all);

  const query = useQuery({
    queryKey,
    retry: scope.retry(queryKey),
    queryFn: () =>
      scope.run(async () => {
        let data: QueueItem[];
        if (isLocalApp) {
          const cloud = captureRendererCloudAccountScope();
          const local =
            (await getLocalDesktopApi().imageRenders.listQueue()) as unknown as QueueItem[];
          scope.work.check();
          data = [...local, ...(await fetchCloudQueue(scope.work, cloud))];
        } else {
          data = await fetchFilteredQueue();
        }
        scope.work.check();
        // The previous successful poll for this client and library is the
        // baseline. The initial snapshot is not a completion event.
        const previous = queryClient.getQueryData<QueueItem[]>(queryKey);
        const before = previous && countQueueItemsByStatus(previous);
        const after = countQueueItemsByStatus(data);
        if (
          before &&
          ((after.error ?? 0) > (before.error ?? 0) ||
            (after.done ?? 0) > (before.done ?? 0))
        ) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.balance.all
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.project.all
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.timelineList.all
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.videoAsset.all
          });
        }

        return data;
      }),
    refetchInterval: (queryState: Query<QueueItem[], Error>) =>
      queueRefetchInterval(queryState),
    refetchIntervalInBackground: true,
    enabled: enabled && scope.active,
    select
  });

  return {
    ...query,
    refetch: async (options) => {
      scope.work.check();
      const result = await query.refetch(options);
      scope.work.check();
      return result;
    },
    triggerRefetch: () => {
      if (!scope.work.signal.aborted) void query.refetch();
    }
  };
}
