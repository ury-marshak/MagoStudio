import type { Layer } from "@schemas/layer";
import type { Project } from "@schemas/project";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import type {
  OrdinaryFalJob,
  OrdinaryFalSubmitRequest,
  OrdinaryFalSubmitResult
} from "../../../desktop/shared/ordinaryFal";

import { useVideoEffects, VIDEO_EFFECTS_LABEL } from "./useVideoEffects";
import { VideoEffectsHistoryButton } from "./VideoEffectsHistoryButton";

vi.mock("@/platform/localDesktop", async (original) => ({
  ...(await original<typeof import("@/platform/localDesktop")>()),
  isLocalApp: true
}));
vi.mock("@components/Modal", () => ({
  Modal: ({
    children,
    onClose,
    title
  }: {
    children: React.ReactNode;
    onClose: () => void;
    title: string;
  }) => (
    <div role="dialog" aria-label={title}>
      {children}
      <button onClick={onClose}>Close</button>
    </div>
  )
}));
vi.mock("@components/OrdinaryFal/OrdinaryFalImagePicker", () => ({
  OrdinaryFalImagePicker: ({
    onChange,
    maxFileUpload
  }: {
    onChange: (ids: string[]) => void;
    maxFileUpload: number;
  }) => (
    <button
      type="button"
      onClick={() => onChange(["ref-3", "ref-1", "ref-2", "ref-4"])}
    >
      Add {maxFileUpload} local references
    </button>
  )
}));

const project = {
  id: "project",
  active: true,
  origin: "local",
  type: "timeline"
} as Project;
const track = {
  id: "track",
  active: true,
  name: "Selected layer",
  timeline_id: "shot",
  project_id: "project",
  clips: [
    {
      id: "source-clip",
      asset_id: "asset-id",
      data: {},
      asset: {
        id: "asset-id",
        name: "Exact take.mov",
        type: "VIDEO",
        project_ids: ["project"],
        data: { status: "ingested" }
      }
    }
  ]
} as Layer;
const config = { keychainAccount: "profile-a", revision: "revision-a" };
const getConfig = vi.fn(async (): Promise<typeof config | null> => config);
const get = vi.fn(
  async (_input: { id: string }): Promise<OrdinaryFalJob | null> => null
);
const list = vi.fn(async (): Promise<OrdinaryFalJob[]> => []);
const row: OrdinaryFalJob = {
  id: "job",
  projectId: "project",
  shotId: "shot",
  kind: "video-upscale",
  model: "fal_topaz_video_upscale",
  status: "SUBMITTED",
  placement: "PENDING",
  assetIds: [],
  clipId: null,
  error: null
};
const submit = vi.fn(
  async ({
    request
  }: OrdinaryFalSubmitRequest): Promise<OrdinaryFalSubmitResult> => ({
    status: "job",
    job: { ...row, id: request.id, kind: request.kind, model: request.model }
  })
);
const network = vi.fn(() => {
  throw new Error("Unexpected renderer network request");
});
let willChange: () => Promise<void>;
let didChange: () => void;
let retire: () => void;
let clients: QueryClient[];
let openFromCurrentRow: () => void;

beforeEach(() => {
  clients = [];
  getConfig.mockClear();
  get.mockClear();
  list.mockClear();
  submit.mockClear();
  vi.stubGlobal("fetch", network);
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: {
      library: {
        onWillChange: async (listener: typeof willChange) => {
          willChange = listener;
        },
        onDidChange: (listener: typeof didChange) => {
          didChange = listener;
        }
      },
      account: {
        isCurrent: () => true,
        onRetired: (listener: typeof retire) => {
          retire = listener;
          return () => {};
        }
      },
      ordinaryFal: { get, list, submit },
      externalProviders: { fal: { get: getConfig } }
    }
  });
});

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const Row = ({
  selectedProject = project,
  selectedTrack = track
}: {
  selectedProject?: Project;
  selectedTrack?: Layer;
}) => {
  const { available, open, dialog } = useVideoEffects(
    selectedProject,
    selectedTrack
  );
  // oxlint-disable-next-line custom-react/no-use-layout-effect -- expose a committed callback for stale event tests
  useLayoutEffect(() => {
    openFromCurrentRow = open;
  }, [open]);
  return (
    <>
      {available && <button onClick={open}>{VIDEO_EFFECTS_LABEL}</button>}
      {dialog}
    </>
  );
};
const setup = (selectedProject = project) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  clients.push(client);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(<Row selectedProject={selectedProject} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  });
  return { ...view, invalidate };
};
const open = async () =>
  fireEvent.click(
    await screen.findByRole("button", { name: VIDEO_EFFECTS_LABEL })
  );
const choose = (value: string) =>
  fireEvent.change(screen.getByLabelText("Effect"), { target: { value } });
const confirm = () =>
  fireEvent.click(
    screen.getByRole("checkbox", { name: /fal bills separately/ })
  );
const submitButton = () =>
  screen.getByRole("button", { name: "Submit to fal" });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("keeps direct effects off cloud projects and unavailable without configured fal", async () => {
  setup({ ...project, origin: "cloud" });
  expect(
    screen.queryByRole("button", { name: VIDEO_EFFECTS_LABEL })
  ).toBeNull();
  expect(getConfig).not.toHaveBeenCalled();
  getConfig.mockResolvedValueOnce(null);
  setup();
  await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
  expect(
    screen.queryByRole("button", { name: VIDEO_EFFECTS_LABEL })
  ).toBeNull();
});

it("requires source-specific consent and audio choice and submits exactly one ordered Kling request", async () => {
  setup();
  await open();
  expect(screen.getByText("Video asset ID: asset-id")).toBeVisible();
  expect(screen.getByText(/whole original video file/)).toBeVisible();
  expect(screen.getByText(/SDR-to-HDR are not supported/)).toBeVisible();
  expect(submitButton()).toBeDisabled();
  choose("video-edit");
  fireEvent.change(screen.getByLabelText("Edit prompt"), {
    target: { value: "  Change the light  " }
  });
  confirm();
  expect(submitButton()).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Output audio"), {
    target: { value: "remove" }
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Add 4 local references" })
  );
  expect(submitButton()).toBeDisabled();
  confirm();
  const form = submitButton().closest("form")!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit).toHaveBeenCalledWith({
    expectedFal: config,
    request: {
      id: expect.any(String),
      projectId: "project",
      shotId: "shot",
      sourceClipId: "source-clip",
      expectedSourceAssetId: "asset-id",
      kind: "video-edit",
      model: "fal_kling_o1_edit",
      prompt: "Change the light",
      keepAudio: false,
      referenceAssetIds: ["ref-3", "ref-1", "ref-2", "ref-4"]
    }
  });
  expect(await screen.findByText(/Queued or processing on fal/)).toBeVisible();
});

it("sends only Topaz's fixed-route fields and checks a lost acknowledgement by the same UUID", async () => {
  submit.mockRejectedValueOnce(new Error("IPC reply lost"));
  setup();
  await open();
  choose("video-upscale");
  expect(screen.getByText(/Fixed Topaz Proteus 2×/)).toBeVisible();
  expect(screen.queryByLabelText("Output audio")).toBeNull();
  confirm();
  fireEvent.click(submitButton());
  expect(
    await screen.findByText(/Submission could not be confirmed/)
  ).toBeVisible();
  expect(submit).toHaveBeenCalledTimes(1);
  const id = submit.mock.calls[0]![0].request.id;
  expect(submit).toHaveBeenCalledWith({
    expectedFal: config,
    request: {
      id,
      projectId: "project",
      shotId: "shot",
      sourceClipId: "source-clip",
      expectedSourceAssetId: "asset-id",
      kind: "video-upscale",
      model: "fal_topaz_video_upscale"
    }
  });
  expect(get).toHaveBeenCalledExactlyOnceWith({ id });
  expect(submitButton()).toBeDisabled();
});

it("shows a definite rejection and lets the user correct the effect without recovery polling for that UUID", async () => {
  submit.mockResolvedValueOnce({
    status: "rejected",
    message: "Trimmed clips are not supported."
  });
  setup();
  await open();
  choose("video-upscale");
  confirm();
  fireEvent.click(submitButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Trimmed clips are not supported."
  );
  expect(screen.queryByText(/Submission could not be confirmed/)).toBeNull();
  expect(get).not.toHaveBeenCalled();
  expect(submitButton()).toBeEnabled();
});

it.each(["close", "source change", "profile retirement"] as const)(
  "blocks a pending confirmation after %s",
  async (action) => {
    const { rerender } = setup();
    await open();
    const previousOpen = openFromCurrentRow;
    const metadata = deferred<typeof config>();
    getConfig.mockReturnValueOnce(metadata.promise);
    choose("video-upscale");
    confirm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
    if (action === "close")
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    if (action === "source change") {
      rerender(
        <Row
          selectedTrack={{
            ...track,
            clips: [{ ...track.clips[0]!, id: "new-clip" }]
          }}
        />
      );
      act(() => previousOpen());
    }
    if (action === "profile retirement") act(() => retire());
    await act(async () => {
      metadata.resolve(config);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  }
);

it("drops old polling and confirmation work after a library switch with reused IDs, and plays only the new local result", async () => {
  const oldHistory = deferred<OrdinaryFalJob[]>();
  const metadata = deferred<typeof config>();
  list.mockReturnValueOnce(oldHistory.promise);
  const { invalidate } = setup();
  await open();
  const previousOpen = openFromCurrentRow;
  const oldKey = libraryQueryKey(queryKeys.project.byId("project"));
  await waitFor(() =>
    expect(list).toHaveBeenCalledExactlyOnceWith({ projectId: "project" })
  );
  getConfig.mockReturnValueOnce(metadata.promise);
  choose("video-upscale");
  confirm();
  fireEvent.click(submitButton());
  await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
  await act(async () => {
    await willChange();
    didChange();
  });
  act(() => previousOpen());
  expect(screen.queryByRole("dialog")).toBeNull();
  list.mockResolvedValueOnce([
    {
      ...row,
      status: "INGESTED",
      placement: "UNATTACHED",
      assetIds: ["new-result"],
      warning: "Timing differs from the input."
    }
  ]);
  await open();
  await act(async () => {
    oldHistory.resolve([
      {
        ...row,
        status: "INGESTED",
        placement: "UNATTACHED",
        assetIds: ["old-result"],
        warning: "Old library warning"
      }
    ]);
    metadata.resolve(config);
  });
  expect(
    await screen.findByLabelText("Local video effect result")
  ).toHaveAttribute("src", "mago-media://asset/new-result");
  expect(screen.getByText("Timing differs from the input.")).toBeVisible();
  expect(screen.queryByText("Old library warning")).toBeNull();
  expect(submit).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: oldKey });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: libraryQueryKey(queryKeys.project.byId("project"))
  });
});

it("opens project-wide read-only history with no source rows or fal config", async () => {
  const { library, account } = window.mago;
  const emptyProject = {
    ...project,
    name: "Project",
    description: "",
    settings: {},
    timelines: []
  };
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: {
      library,
      account,
      projects: { get: vi.fn(async () => emptyProject) },
      ordinaryFal: { get, list, submit }
    }
  });
  const unattached = {
    ...row,
    shotId: "removed-shot",
    status: "INGESTED",
    placement: "UNATTACHED",
    assetIds: ["saved-result"],
    warning: "The source was removed."
  } as const;
  const result = { ...unattached, assetIds: [...unattached.assetIds] };
  list.mockResolvedValueOnce([
    result,
    {
      ...result,
      id: "attached-job",
      placement: "ATTACHED",
      assetIds: ["attached-result"]
    },
    {
      ...result,
      id: "other-project-job",
      projectId: "other",
      assetIds: ["foreign-result"]
    },
    {
      ...result,
      id: "other-kind-job",
      kind: "reference-video",
      assetIds: ["non-effect-result"]
    }
  ]);
  const client = new QueryClient();
  clients.push(client);
  render(<VideoEffectsHistoryButton projectId={project.id} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  });
  const history = await screen.findByRole("button", {
    name: "Video effects history"
  });
  expect(list).not.toHaveBeenCalled();
  fireEvent.click(history);
  expect(
    await screen.findByText("Saved locally; not attached to the timeline", {
      exact: false
    })
  ).toBeVisible();
  expect(
    screen
      .getAllByLabelText("Local video effect result")
      .map((video) => video.getAttribute("src"))
  ).toEqual([
    "mago-media://asset/saved-result",
    "mago-media://asset/attached-result"
  ]);
  expect(screen.queryByRole("button", { name: "Submit to fal" })).toBeNull();
  expect(list).toHaveBeenCalledExactlyOnceWith({ projectId: project.id });
  expect(getConfig).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
