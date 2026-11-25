import { ConnectedQueueRenderItem } from "@components/QueuePanel/ConnectedQueueRenderItem";
import { TrackMenu } from "@home/components/TimelineList/TracksList/RenderTrackItem/TrackMenu";
import { type QueueItem } from "@hooks/queue/interface";
import { AssetStatus } from "@schemas/asset";
import { type Layer } from "@schemas/layer";
import { type ToastOptions } from "@store/atoms/toastAtom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

const mocks = vi.hoisted(() => ({
  showToast: vi.fn<(toast: ToastOptions) => void>(),
  closeMenu: vi.fn(),
  cancelJob: vi.fn(),
  deleteTrack: vi.fn(),
  cloudDelete: vi.fn(),
  selectTracks: vi.fn(),
  trackDeleted: vi.fn(),
  renderCancelled: vi.fn()
}));

vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { delete: mocks.cloudDelete }
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => ({
    imageRenders: { cancel: mocks.cancelJob },
    library: { onWillChange: async () => {}, onDidChange: () => {} }
  })
}));
vi.mock("@domains/track/api/deleteTrack", () => ({
  deleteTrack: mocks.deleteTrack
}));
vi.mock("@store/useToast", () => ({
  useToast: () => ({ showToast: mocks.showToast })
}));
vi.mock("@hooks/tracking/trackingUtils", () => ({
  trackingUtils: {
    trackActions: { delete: mocks.trackDeleted },
    renderActions: { cancel: mocks.renderCancelled }
  }
}));
vi.mock("@components/Menu", () => ({
  Menu: ({
    children
  }: {
    children: (args: { close: () => void }) => ReactNode;
  }) => children({ close: mocks.closeMenu })
}));
vi.mock("@components/MenuList", () => ({
  MenuList: ({ children }: { children: ReactNode }) => <div>{children}</div>
}));
vi.mock("@components/MenuItem", () => ({
  MenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>
}));
vi.mock("@components/MenuItemButton", () => ({ MenuItemButton: "button" }));
vi.mock("@components/MenuItemText", () => ({
  MenuItemText: ({ title }: { title: string }) => <span>{title}</span>
}));
vi.mock("@components/QueueRenderItem/QueueRenderItem", () => ({
  QueueRenderItem: ({ onDelete }: { onDelete: () => void }) => (
    <button onClick={onDelete}>Stop render</button>
  )
}));
vi.mock(
  "@home/components/TimelineList/TracksList/RenderTrackItem/TrackMenu/CopyRenderSettingsMenuItem",
  () => ({ CopyRenderSettingsMenuItem: () => null })
);
vi.mock("@domains/queue/useResolvedQueueStatus", () => ({
  useResolvedQueueStatus: () => ({ status: "FINISHED" })
}));
vi.mock("@domains/project/useSelectedProjectId", () => ({
  useSelectedProjectId: () => "project"
}));
vi.mock("@domains/shot/useSelectedShot", () => ({
  useSelectedShot: () => ({})
}));
vi.mock("@domains/shot/useSelectedShotId", () => ({
  useSelectedShotId: () => ({ selectedShotId: "shot" })
}));
vi.mock("@domains/track/useFilteredAndSortedTracks", () => ({
  useFilteredAndSortedTracks: () => ({ data: { videoTrack: { id: "video" } } })
}));
vi.mock("@domains/track/useGetTrackById", () => ({
  useGetTrackById: () => ({})
}));
vi.mock("@domains/track/useSelectedTrackIds", () => ({
  useSelectedTrackIds: () => ["track"]
}));
vi.mock("@domains/track/useSetSelectedTrackIds", () => ({
  useSetSelectedTrackIds: () => mocks.selectTracks
}));
vi.mock("@hooks/files/useDownloadInfoRichVideo", () => ({
  useDownloadInfoRichVideo: () => ({})
}));
vi.mock("@hooks/files/utils", () => ({
  isEXRRender: () => false,
  areFramesDownloadable: () => false,
  isVideoDownloadable: () => false,
  areVideoAndFramesDownloadable: () => false,
  isEXRDownloadable: () => false
}));
vi.mock("@hooks/queue/useMarkQueueItemInteracted", () => ({
  useMarkQueueItemInteracted: () => ({})
}));
vi.mock("@hooks/queue/useQueue", async () => {
  const { useQueryClient } = await import("@tanstack/react-query");
  const { queryKeys } = await import("@/queryKeys");
  return {
    useQueue: () => ({
      data: useQueryClient().getQueryData(libraryQueryKey(queryKeys.queue.all))
    })
  };
});

const track = {
  id: "track",
  timeline_id: "shot",
  name: "Track",
  clips: [{ asset: { id: "asset" } }]
} as Layer;
const queueItem = (library: string) =>
  ({
    id: "job",
    layer_id: track.id,
    layer_name: track.name,
    asset_id: "asset",
    status: AssetStatus.PENDING,
    render_provider: "mago-cloud",
    local_cloud_render_job_id: "job",
    cloud_queue_item_id: `${library}-queue`,
    cloud_output_layer_id: `${library}-layer`
  }) as QueueItem;

const setup = (kind: "track" | "queue") => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const setHidden = vi.fn();
  const show = (library: string) => {
    client.setQueryData(libraryQueryKey(queryKeys.queue.all), [
      queueItem(library)
    ]);
    return (
      <QueryClientProvider client={client}>
        {kind === "track" ? (
          <TrackMenu track={track} setIsHiddenWhileDeleting={setHidden} />
        ) : (
          <ConnectedQueueRenderItem
            item={queueItem(library)}
            onClose={vi.fn()}
          />
        )}
      </QueryClientProvider>
    );
  };
  const { rerender } = render(show("A"));
  const openToast = () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: kind === "track" ? "Delete layer" : "Stop render"
      })
    );
    expect(mocks.showToast).toHaveBeenCalled();
    return mocks.showToast.mock.lastCall![0];
  };
  const switchLibrary = () =>
    act(async () => {
      await rendererLibrary.suspend();
      rendererLibrary.reset();
      rerender(show("B"));
    });
  return { openToast, switchLibrary, invalidate, setHidden, client };
};

beforeEach(() => vi.resetAllMocks());

it.each(["onSubmit", "onClose", "onCancel"] as const)(
  "ignores the old track confirmation's %s after reset with reused IDs",
  async (callback) => {
    const { openToast, switchLibrary, invalidate, setHidden } = setup("track");
    const toast = openToast();
    expect(setHidden).toHaveBeenLastCalledWith(true);
    await switchLibrary();
    expect(setHidden).toHaveBeenLastCalledWith(false);
    setHidden.mockClear();
    mocks.selectTracks.mockClear();
    await act(async () => toast[callback]?.());
    expect(mocks.cloudDelete).not.toHaveBeenCalled();
    expect(mocks.cancelJob).not.toHaveBeenCalled();
    expect(mocks.deleteTrack).not.toHaveBeenCalled();
    expect(mocks.closeMenu).not.toHaveBeenCalled();
    expect(mocks.selectTracks).not.toHaveBeenCalled();
    expect(setHidden).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  }
);

it("ignores an old queue confirmation but allows a fresh stop of the reused job", async () => {
  const { openToast, switchLibrary, invalidate } = setup("queue");
  const toast = openToast();
  await switchLibrary();
  await act(async () => toast.onSubmit?.());
  expect(mocks.cloudDelete).not.toHaveBeenCalled();
  expect(mocks.cancelJob).not.toHaveBeenCalled();
  expect(mocks.renderCancelled).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();

  const current = openToast();
  await act(async () => current.onSubmit?.());
  expect(mocks.cloudDelete).toHaveBeenCalledExactlyOnceWith("/queue/B-queue", {
    signal: expect.any(AbortSignal)
  });
  expect(mocks.cancelJob).toHaveBeenCalledExactlyOnceWith("job");
  expect(mocks.renderCancelled).toHaveBeenCalledExactlyOnceWith(
    "Track",
    "asset"
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.balance.all });
});

it.each([
  ["track", ["/queue/A-queue"]],
  ["queue", ["/queue/A-queue"]],
  ["track", ["/queue/A-queue", "/layers/A-layer"]]
] as const)(
  "retires the %s cascade while DELETEs %j are outstanding",
  async (kind, urls) => {
    const { openToast, switchLibrary, invalidate, client } = setup(kind);
    const held = Promise.withResolvers<void>();
    if (urls.length === 2) mocks.cloudDelete.mockResolvedValueOnce(undefined);
    mocks.cloudDelete.mockReturnValueOnce(held.promise);
    const toast = openToast();
    let submission: unknown;
    await act(async () => {
      submission = toast.onSubmit?.();
    });
    expect(mocks.cloudDelete.mock.calls.map(([url]) => url)).toEqual(urls);
    const signal = mocks.cloudDelete.mock.lastCall?.[1].signal as AbortSignal;

    await switchLibrary();
    expect(signal.aborted).toBe(true);
    mocks.selectTracks.mockClear();
    await act(async () => {
      held.resolve();
      await submission;
    });
    await waitFor(() => expect(client.isMutating()).toBe(0));

    expect(mocks.cloudDelete).toHaveBeenCalledTimes(urls.length);
    expect(mocks.cancelJob).not.toHaveBeenCalled();
    expect(mocks.deleteTrack).not.toHaveBeenCalled();
    expect(mocks.selectTracks).not.toHaveBeenCalled();
    expect(mocks.trackDeleted).not.toHaveBeenCalled();
    expect(mocks.renderCancelled).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryData(libraryQueryKey(queryKeys.queue.all))).toEqual([
      queueItem("B")
    ]);
  }
);

it("runs both mutations for a current track confirmation", async () => {
  const { openToast, invalidate } = setup("track");
  await act(async () => openToast().onSubmit?.());
  await waitFor(() => expect(mocks.trackDeleted).toHaveBeenCalledOnce());
  expect(mocks.cloudDelete.mock.calls.map(([url]) => url)).toEqual([
    "/queue/A-queue",
    "/layers/A-layer"
  ]);
  expect(mocks.cancelJob).toHaveBeenCalledExactlyOnceWith("job");
  expect(mocks.deleteTrack).toHaveBeenCalledExactlyOnceWith(
    { trackId: "track", projectId: "project", shotId: "shot" },
    expect.objectContaining({
      signal: mocks.cloudDelete.mock.calls[0][1].signal
    })
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.queue.all });
});
