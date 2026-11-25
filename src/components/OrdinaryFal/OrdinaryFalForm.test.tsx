import { DirectFalImg2ImgForm } from "@home/components/Navbar/Img2ImgModalV2/DirectFalImg2ImgForm";
import { DirectFalImageToVideoForm } from "@home/project-timeline/components/ImageToVideoModal/DirectFalImageToVideoForm";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import type {
  OrdinaryFalAccount,
  OrdinaryFalJob,
  OrdinaryFalSubmitInput,
  OrdinaryFalSubmitRequest,
  OrdinaryFalSubmitResult
} from "../../../desktop/shared/ordinaryFal";

import {
  OrdinaryFalRouteSelect,
  useOrdinaryFalRoute
} from "./OrdinaryFalRouteSelect";
import { OrdinaryFalStatus } from "./OrdinaryFalStatus";

vi.mock("@/platform/localDesktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/localDesktop")>()),
  isLocalApp: true
}));
vi.mock("@domains/project/useProject", () => ({
  useProject: () => ({ data: { origin: "local" } })
}));
vi.mock("@domains/shot/useImageToVideoContainerShot", () => ({
  useImageToVideoContainerShot: () => ({ ensureContainerShotId })
}));
vi.mock("@domains/track/useInputTrackFrameSrc", () => ({
  useInputTrackFrameSrc: () => ({ inputTrackFrameSrc: still })
}));
vi.mock("@store/cropStore", () => ({ useShotCrop: () => ({}) }));
vi.mock("react-hook-form", () => ({ useWatch: () => ["video"] }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));
vi.mock("@components/OrdinaryFal/OrdinaryFalImagePicker", () => ({
  OrdinaryFalImagePicker: ({
    onChange
  }: {
    onChange: (ids: string[]) => void;
  }) => (
    <button type="button" onClick={() => onChange(["still-1", "still-2"])}>
      Select stills
    </button>
  )
}));

const still = "data:image/jpeg;base64,AA==";
const ensureContainerShotId = vi.fn(async () => "i2v-shot");
const createTrack = vi.fn(async () => ({ id: "output-track" }));
const importImage = vi.fn(async () => ({ id: "prepared-still" }));
const get = vi.fn(async () => ({
  type: "IMAGE",
  project_ids: ["project"],
  data: { status: "ingested" }
}));
const ack = ({
  id,
  projectId,
  shotId,
  kind,
  model
}: OrdinaryFalSubmitInput): OrdinaryFalJob => ({
  id,
  projectId,
  shotId,
  kind,
  model,
  status: "SUBMITTED",
  placement: "PENDING",
  clipId: null,
  assetIds: [],
  error: null
});
const submit = vi.fn(
  async ({
    request
  }: OrdinaryFalSubmitRequest): Promise<OrdinaryFalSubmitResult> => ({
    status: "job",
    job: ack(request)
  })
);
const list = vi.fn<() => Promise<OrdinaryFalJob[]>>(async () => []);
const expectedFal = { keychainAccount: "configured", revision: "revision-a" };
const config = vi.fn<() => Promise<OrdinaryFalAccount | null>>(
  async () => expectedFal
);
const close = vi.fn();
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("mago", {
    library: { onWillChange: async () => {}, onDidChange: () => () => {} },
    externalProviders: { fal: { get: config } },
    assets: { get, importImage },
    tracks: { create: createTrack },
    ordinaryFal: { submit, list, get: vi.fn() }
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 960, height: 540, close }))
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const show = (child: React.ReactNode) =>
  render(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
const prompt = (value: string) =>
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value } });
const generate = () =>
  screen.getByRole("button", { name: "Generate with fal" });

it("imports the chosen frame through the local prepared-image path before submitting image edit", async () => {
  const localFetch = vi.fn(async () => new Response(new Blob()));
  vi.stubGlobal("fetch", localFetch);
  show(
    <DirectFalImg2ImgForm projectId="project" shotId="shot" currentFrame={17} />
  );
  prompt("Redraw this still");
  fireEvent.change(screen.getByLabelText("fal model"), {
    target: { value: "fal_minimax_h3_image" }
  });
  fireEvent.change(
    screen.getByLabelText("script_project.fal_settings.megapixels"),
    { target: { value: "4" } }
  );
  await waitFor(() => expect(generate()).toBeEnabled());
  fireEvent.click(generate());
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(importImage).toHaveBeenCalledExactlyOnceWith({
    projectId: "project",
    dataUrl: still,
    name: "Frame 17.jpg",
    width: 960,
    height: 540
  });
  expect(importImage.mock.invocationCallOrder[0]).toBeLessThan(
    submit.mock.invocationCallOrder[0]!
  );
  expect(localFetch).toHaveBeenCalledExactlyOnceWith(still, {
    signal: expect.any(AbortSignal)
  });
  expect(close).toHaveBeenCalledOnce();
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    expectedFal,
    request: expect.objectContaining({
      kind: "image-edit",
      model: "fal_minimax_h3_image",
      projectId: "project",
      shotId: "shot",
      baseAssetId: "prepared-still",
      frame: 17,
      canvas: { width: 960, height: 540 },
      settings: { megapixels: "4", aspect_ratio: "layout" }
    })
  });
});

it("sends only ordered reference stills to H3 Max with a local output track and supported duration", async () => {
  show(<DirectFalImageToVideoForm projectId="project" />);
  prompt("  Slow pan  ");
  expect(screen.getByText(/not exact opening frames/)).toBeInTheDocument();
  expect(generate()).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Select stills" }));
  fireEvent.change(screen.getByLabelText("Duration (seconds)"), {
    target: { value: "4" }
  });
  expect(generate()).toBeDisabled();
  expect(createTrack).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Duration (seconds)"), {
    target: { value: "7" }
  });
  await waitFor(() => expect(generate()).toBeEnabled());
  fireEvent.click(generate());
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(ensureContainerShotId).toHaveBeenCalledOnce();
  expect(createTrack).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ type: "RENDER", shotId: "i2v-shot" })
  );
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    expectedFal,
    request: {
      id: expect.any(String),
      kind: "reference-video",
      model: "minimax_h3_max",
      projectId: "project",
      shotId: "i2v-shot",
      trackId: "output-track",
      timelineOffsetMs: 0,
      durationSeconds: 7,
      prompt: "Slow pan",
      referenceAssetIds: ["still-1", "still-2"],
      settings: undefined
    }
  });
});

it("keeps explicit fal selected and blocks preparation when settings are missing", async () => {
  config.mockResolvedValueOnce(null);
  const TestView = () => {
    const route = useOrdinaryFalRoute("project");
    return (
      <>
        <OrdinaryFalRouteSelect {...route} />
        {route.selected ? (
          <DirectFalImageToVideoForm projectId="project" />
        ) : (
          <button type="button">Legacy generate</button>
        )}
      </>
    );
  };
  show(<TestView />);
  expect(
    screen.getByRole("button", { name: "Legacy generate" })
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Render route"), {
    target: { value: "fal" }
  });
  prompt("Pan");
  fireEvent.click(screen.getByRole("button", { name: "Select stills" }));
  await screen.findByText("Configure fal in Settings → Providers.");
  expect(generate()).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Legacy generate" })
  ).not.toBeInTheDocument();
  expect(ensureContainerShotId).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("looks up job placement in the tool and invalidates only the originating library's project", async () => {
  const base: OrdinaryFalJob = {
    id: "job",
    kind: "image-edit",
    model: "fal_nano_banana_2",
    projectId: "project",
    shotId: "shot-a",
    status: "INGESTED",
    placement: "PENDING",
    assetIds: ["output"],
    clipId: null,
    error: null
  };
  list.mockResolvedValueOnce([base]);
  const originKey = libraryQueryKey(queryKeys.project.byId("project"));
  const unrelatedKey = libraryQueryKey(queryKeys.project.byId("unrelated"));
  client.setQueryData(originKey, {});
  client.setQueryData(unrelatedKey, {});
  show(
    <OrdinaryFalStatus projectId="project" shotId="shot-b" kind="image-edit" />
  );
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(client.getQueryState(originKey)?.isInvalidated).toBe(false);
  list.mockResolvedValueOnce([
    { ...base, placement: "ATTACHED", clipId: "clip" }
  ]);
  await act(() => client.refetchQueries({ queryKey: ["ordinaryFal", "jobs"] }));
  await waitFor(() =>
    expect(client.getQueryState(originKey)?.isInvalidated).toBe(true)
  );
  expect(client.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  expect(screen.queryByText("Added to the timeline")).not.toBeInTheDocument();
});

it("does not publish a status result delivered after library replacement", async () => {
  let resolve!: (jobs: OrdinaryFalJob[]) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const oldKey = libraryQueryKey(queryKeys.project.byId("project"));
  client.setQueryData(oldKey, {});
  show(
    <OrdinaryFalStatus projectId="project" shotId="shot" kind="image-edit" />
  );
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
  const newKey = libraryQueryKey(queryKeys.project.byId("project"));
  client.setQueryData(newKey, {});
  await act(async () =>
    resolve([
      {
        id: "job",
        kind: "image-edit",
        model: "fal_nano_banana_2",
        projectId: "project",
        shotId: "shot",
        status: "INGESTED",
        placement: "ATTACHED",
        assetIds: ["output"],
        clipId: "clip",
        error: null
      }
    ])
  );
  expect(screen.queryByText("Added to the timeline")).not.toBeInTheDocument();
  expect(client.getQueryState(oldKey)?.isInvalidated).toBe(false);
  expect(client.getQueryState(newKey)?.isInvalidated).toBe(false);
});
