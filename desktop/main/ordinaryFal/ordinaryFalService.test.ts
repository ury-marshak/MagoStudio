import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import ffmpegPath from "ffmpeg-static";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { FalProviderMetadata } from "../../shared/contracts";
import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3
} from "../../shared/falSheetModel";
import { FAL_SHOT_ENGINE } from "../../shared/falShotModel";
import { FAL_KLING_EDIT, FAL_TOPAZ_UPSCALE } from "../../shared/ordinaryFal";
import { DatabaseManager } from "../database/databaseManager";
import {
  assets,
  clips,
  externalRenderJobs,
  ordinaryFalJobs,
  projectAssets,
  projects,
  shots,
  tracks
} from "../database/schema";
import { ExternalRenderJobRepository } from "../providers/externalRenderJobRepository";
import { ProfileLifetime } from "../providers/profileLifetime";

import {
  externalJobId,
  parseOrdinaryFalInput,
  prepareOrdinaryFalRequest
} from "./ordinaryFalRequest";
import { OrdinaryFalService } from "./ordinaryFalService";
import { probeEffectVideo } from "./probeEffectVideo";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 960, height: 640 })
    })
  }
}));
vi.mock("./probeEffectVideo", async (original) => ({
  ...(await original<typeof import("./probeEffectVideo")>()),
  probeEffectVideo: vi.fn(async () => ({
    durationSeconds: 7,
    width: 1280,
    height: 768,
    fps: 24,
    hasAudio: true,
    presentationSignature: `pts-us-v1:${"a".repeat(64)}`,
    sizeBytes: 2048
  }))
}));
vi.mock("../media/imageThumbnail", () => ({
  createImageThumbnail: async () => {}
}));
vi.mock("../media/doesVideoHaveAudioStream", () => ({
  doesVideoHaveAudioStream: async () => true
}));
vi.mock("../cloud/probeRenderedVideoMetadata", () => ({
  probeRenderedVideoMetadata: async () => ({
    width: 1280,
    height: 768,
    fps: 24,
    frameCount: 168
  })
}));

const projectId = "project";
const shotId = "shot";
const trackId = "render-track";
const outputUrl = "https://v3.fal.media/render-fixture";
const account = "original-keychain-account";
const confirmedFal = { keychainAccount: account, revision: "a".repeat(64) };
const acknowledged = () =>
  Response.json({ request_id: "request-1", status: "IN_QUEUE" });
const imageInput = (id = randomUUID()) =>
  ({
    id,
    projectId,
    shotId,
    kind: "image-edit",
    model: FAL_SHEET_MODEL,
    prompt: "Change the sky",
    baseAssetId: "base",
    referenceAssetIds: ["ref"],
    frame: 10,
    canvas: { width: 1920, height: 1080 }
  }) as const;
const videoInput = () =>
  ({
    id: randomUUID(),
    projectId,
    shotId,
    kind: "reference-video",
    model: FAL_SHOT_ENGINE,
    prompt: "Animate this reference",
    referenceAssetIds: ["base"],
    trackId,
    timelineOffsetMs: 1000,
    durationSeconds: 8,
    settings: { seed: 0 }
  }) as const;

let manager: DatabaseManager;
let directories: string[];
let directory: string;
let service: OrdinaryFalService;
let profile: ProfileLifetime;
let config: FalProviderMetadata | null;
let getFal: ReturnType<typeof vi.fn<() => Promise<FalProviderMetadata | null>>>;

const submitRequest = (request: unknown, expectedFal = confirmedFal) =>
  service.submit({ request, expectedFal }, profile.capture());
const submitJob = async (request: unknown) => {
  const result = await submitRequest(request);
  if (result.status === "rejected") throw new Error(result.message);
  return result.job;
};
let readKey: ReturnType<
  typeof vi.fn<(account: string, signal?: AbortSignal) => Promise<string>>
>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let generationPost: ReturnType<typeof vi.fn<() => Promise<Response>>>;
let payload: unknown;
let generationEndpoint: string | undefined;
let outputKind: "image" | "video";

async function openFixture() {
  directory = await mkdtemp(path.join(tmpdir(), "ordinary-fal-"));
  directories.push(directory);
  await manager.open(directory);
  await manager
    .get()
    .insert(projects)
    .values({ id: projectId, name: "Fixture project" });
  await manager
    .get()
    .insert(shots)
    .values({ id: shotId, projectId, name: "Fixture shot" });
  await manager.get().insert(tracks).values({
    id: trackId,
    projectId,
    shotId,
    name: "Video render",
    type: "RENDER"
  });
  for (const id of ["base", "ref"]) {
    const sourcePath = path.join(directory, `${id}.png`);
    await writeFile(sourcePath, id);
    await manager
      .get()
      .insert(assets)
      .values({ id, name: id, type: "image", sourcePath });
    await manager
      .get()
      .insert(projectAssets)
      .values({ projectId, assetId: id });
  }
}

function newService() {
  return new OrdinaryFalService({
    databaseManager: manager,
    getLibraryRoot: async () => directory,
    getFal,
    captureProfile: () => profile.capture(),
    readKey
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fetchUrl = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : String(input);

beforeEach(async () => {
  manager = new DatabaseManager();
  directories = [];
  profile = new ProfileLifetime();
  config = confirmedFal;
  getFal = vi.fn(async () => config);
  readKey = vi.fn(async () => "fake-key-only");
  generationPost = vi.fn(async () => acknowledged());
  payload = undefined;
  generationEndpoint = undefined;
  outputKind = "image";
  vi.mocked(probeEffectVideo).mockClear();
  let upload = 0;
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(fetchUrl(input));
    if (url.hostname === "rest.fal.ai" && init?.method === "POST") {
      upload++;
      return Response.json({
        file_url: `https://v3.fal.media/input-${upload}`,
        upload_url: `https://fixture.invalid/put-${upload}`
      });
    }
    if (url.hostname === "fixture.invalid" && init?.method === "PUT")
      return new Response(null);
    if (url.hostname === "queue.fal.run" && init?.method === "POST") {
      generationEndpoint = url.pathname;
      if (typeof init.body !== "string") throw new Error("Expected JSON");
      payload = JSON.parse(init.body);
      expect(new Headers(init.headers).get("x-app-fal-disable-fallback")).toBe(
        "true"
      );
      return generationPost();
    }
    if (url.hostname === "queue.fal.run" && init?.method === "GET") {
      if (url.pathname.endsWith("/status"))
        return Response.json({ request_id: "request-1", status: "COMPLETED" });
      return Response.json(
        outputKind === "image"
          ? { images: [{ url: outputUrl }] }
          : { video: { url: outputUrl } }
      );
    }
    if (url.href === outputUrl) return new Response("rendered fixture");
    throw new Error(`Unexpected mocked request: ${url.href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  await openFixture();
  service = newService();
});

afterEach(async () => {
  await service.suspend();
  manager.close();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("reopens an acknowledged image edit, ignores changed defaults and missing inputs, and attaches once", async () => {
  const input = { ...imageInput(), settings: { resolution: "2K" } };
  config = {
    ...confirmedFal,
    generationSettings: {
      [FAL_SHEET_MODEL]: { aspect_ratio: "4:3", resolution: "4K" }
    }
  };
  await manager
    .get()
    .update(projects)
    .set({
      settingsJson: JSON.stringify({
        fal_generation_settings: {
          [FAL_SHEET_MODEL]: { aspect_ratio: "3:2", resolution: "1K" }
        }
      })
    })
    .where(eq(projects.id, projectId));
  generationPost.mockImplementationOnce(async () => {
    const [reserved] = await manager.get().select().from(ordinaryFalJobs);
    expect(reserved).toMatchObject({
      shotId,
      placement: "PENDING",
      effectiveSettings: { resolution: "2K" }
    });
    expect(
      await new ExternalRenderJobRepository(manager).get(
        externalJobId(input.id)
      )
    ).toMatchObject({ status: "SUBMITTING" });
    return acknowledged();
  });
  const [submitted] = await Promise.all([submitJob(input), submitJob(input)]);
  expect((await service.get({ id: input.id }, profile.capture()))?.status).toBe(
    "SUBMITTED"
  );
  expect(JSON.stringify(submitted)).not.toMatch(
    /request-1|fake-key-only|original-keychain-account|fal\.media/
  );
  expect(generationEndpoint).toBe("/fal-ai/nano-banana-2/edit");
  expect(payload).toMatchObject({
    resolution: "2K",
    aspect_ratio: "3:2",
    num_images: 1,
    image_urls: ["https://v3.fal.media/input-1", "https://v3.fal.media/input-2"]
  });
  await service.suspend();
  manager.close();
  await rm(path.join(directory, "base.png"));
  await manager.open(directory);
  config = {
    ...confirmedFal,
    generationSettings: { [FAL_SHEET_MODEL]: { resolution: "4K" } }
  };
  service = newService();
  await service.recover();
  await service.recover();
  const item = await service.get({ id: input.id }, profile.capture());
  expect(item).toMatchObject({
    status: "INGESTED",
    placement: "ATTACHED",
    assetIds: [expect.any(String)]
  });
  const outputs = await manager
    .get()
    .select()
    .from(assets)
    .where(eq(assets.origin, "generated"));
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toMatchObject({ width: 960, height: 640 });
  const [clip] = await manager.get().select().from(clips);
  expect(clip).toMatchObject({ id: item?.clipId, assetId: outputs[0]?.id });
  expect(JSON.parse(clip!.dataJson)).toMatchObject({
    frame: 10,
    source: "base",
    status: "success",
    externalRender: { settings: { resolution: "2K" } }
  });
  expect(
    await manager.get().select().from(tracks).where(eq(tracks.type, "IMG2IMG"))
  ).toHaveLength(1);
  expect(generationPost).toHaveBeenCalledOnce();
  expect(
    fetchMock.mock.calls.some(([url]) => fetchUrl(url).endsWith("/cancel"))
  ).toBe(false);
});

it("validates supported fields, destination and every image before looking up a key", async () => {
  const input = imageInput();
  for (const request of [
    { ...input, endpoint: "https://example.invalid" },
    { ...input, settings: { mask: "file" } },
    { ...videoInput(), openingFrame: "base" }
  ])
    await expect(submitRequest(request)).resolves.toMatchObject({
      status: "rejected"
    });
  expect(getFal).not.toHaveBeenCalled();
  await expect(
    submitRequest({ ...videoInput(), trackId: "foreign-track" })
  ).resolves.toMatchObject({
    status: "rejected",
    message: expect.stringContaining("active render track")
  });
  await manager
    .get()
    .update(assets)
    .set({ type: "video" })
    .where(eq(assets.id, "ref"));
  await expect(submitJob(input)).resolves.toMatchObject({
    status: "NOT_SUBMITTED"
  });
  expect(readKey).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  { ...confirmedFal, keychainAccount: "replacement-account" },
  { ...confirmedFal, revision: "b".repeat(64) }
])(
  "rejects a stale confirmation after accepting work in a new provider epoch",
  async (replacement) => {
    const input = imageInput();
    profile.rotate();
    config = replacement;
    await expect(submitRequest(input)).resolves.toMatchObject({
      status: "rejected",
      message: expect.stringContaining("account or configuration changed")
    });
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await manager.get().select().from(ordinaryFalJobs)).toEqual([]);
  }
);

it("gives a definite rejection while provider admission is closed before submit", async () => {
  const origin = new AbortController().signal;
  profile.suspend();
  await expect(
    service.submit({ request: imageInput(), expectedFal: confirmedFal }, origin)
  ).resolves.toMatchObject({
    status: "rejected",
    message: expect.stringContaining("account or configuration changed")
  });
  expect(readKey).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await manager.get().select().from(ordinaryFalJobs)).toEqual([]);
});

it("maps both additional edit models to fixed endpoints with their own settings", () => {
  for (const [model, endpoint, parameters] of [
    [
      FAL_SHEET_MODEL_21,
      "google/nano-banana-2.1/edit",
      { aspect_ratio: "16:9", resolution: "1K" }
    ],
    [
      FAL_SHEET_MODEL_H3,
      "minimax/h3-image/edit",
      { image_size: { width: 1360, height: 768 } }
    ]
  ] as const) {
    const { submission } = prepareOrdinaryFalRequest(
      parseOrdinaryFalInput({ ...imageInput(), model }),
      { keychainAccount: account }
    );
    expect(submission).toMatchObject({
      endpoint,
      assetUrlField: "image_urls",
      requestJson: parameters
    });
  }
});

it("uses only H3 Max image references and attaches with measured video metadata", async () => {
  outputKind = "video";
  const input = videoInput();
  await submitJob(input);
  expect(generationEndpoint).toBe("/minimax/h3-max/reference-to-video");
  expect(payload).toEqual({
    prompt: input.prompt,
    duration: 8,
    resolution: "768P",
    aspect_ratio: "16:9",
    prompt_expansion_mode: "disabled",
    seed: 0,
    reference_image_urls: ["https://v3.fal.media/input-1"]
  });
  await service.recover();
  const item = await service.get({ id: input.id }, profile.capture());
  expect(item).toMatchObject({ status: "INGESTED", placement: "ATTACHED" });
  const [asset] = await manager
    .get()
    .select()
    .from(assets)
    .where(eq(assets.id, item!.assetIds[0]!));
  expect(asset).toMatchObject({
    frameCount: 168,
    duration: 7000,
    fps: 24000,
    width: 1280,
    height: 768
  });
  const [clip] = await manager.get().select().from(clips);
  expect(clip).toMatchObject({
    id: item?.clipId,
    trackId,
    assetId: asset?.id,
    timelineOffset: 1000
  });
});

it("reconciles an already ingested output without another download and preserves media when the destination is gone", async () => {
  const input = videoInput();
  await submitJob(input);
  const jobs = new ExternalRenderJobRepository(manager);
  const id = externalJobId(input.id);
  const output = { urls: [outputUrl] };
  await jobs.settleRemoteJob(id, {
    status: "OUTPUT_READY",
    outputJson: output
  });
  await jobs.finishIngestion((await jobs.get(id))!, output, [
    {
      id: "fixture-output",
      name: "local",
      type: "video",
      sourcePath: "fixture"
    }
  ]);
  await manager.get().delete(tracks).where(eq(tracks.id, trackId));
  await service.suspend();
  service = newService();
  fetchMock.mockClear();
  await service.recover();
  await service.recover();
  expect(await service.get({ id: input.id }, profile.capture())).toMatchObject({
    status: "INGESTED",
    placement: "UNATTACHED",
    assetIds: ["fixture-output"],
    clipId: null
  });
  expect(await manager.get().select().from(clips)).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not resubmit an ambiguous POST with the same UUID, or claim unrelated external jobs", async () => {
  generationPost.mockRejectedValueOnce(new Error("lost response"));
  const input = imageInput();
  await expect(submitJob(input)).resolves.toMatchObject({
    status: "SUBMISSION_UNKNOWN"
  });
  await expect(
    submitRequest({ ...input, prompt: "different" })
  ).resolves.toMatchObject({
    status: "rejected",
    message: expect.stringMatching(/different request/)
  });
  const otherId = randomUUID();
  await manager.get().insert(externalRenderJobs).values({
    id: otherId,
    projectId,
    provider: "fal",
    endpoint: "/director",
    kind: "video",
    keychainAccount: account,
    status: "SUBMITTED",
    requestId: "director-request",
    inputAssetIds: [],
    requestJson: {}
  });
  await service.suspend();
  service = newService();
  await service.recover();
  await expect(submitJob(input)).resolves.toMatchObject({
    status: "SUBMISSION_UNKNOWN"
  });
  expect(await service.list({}, profile.capture())).toHaveLength(1);
  expect(await service.get({ id: otherId }, profile.capture())).toBeNull();
  expect(generationPost).toHaveBeenCalledOnce();
});

it("does not publish a late acknowledgement to a retired profile or poll with a different keychain account", async () => {
  const started = deferred<void>();
  const reply = deferred<Response>();
  generationPost.mockImplementationOnce(() => {
    started.resolve();
    return reply.promise;
  });
  const input = imageInput();
  const submitting = submitJob(input);
  await started.promise;
  profile.rotate();
  config = { keychainAccount: "different-profile", revision: randomUUID() };
  try {
    await expect(submitting).rejects.toThrow("profile changed");
    expect(
      await service.get({ id: input.id }, profile.capture())
    ).toMatchObject({
      status: "SUBMISSION_UNKNOWN"
    });
  } finally {
    reply.resolve(acknowledged());
  }
  fetchMock.mockClear();
  readKey.mockClear();
  await service.recover();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readKey).not.toHaveBeenCalled();
  expect(generationPost).toHaveBeenCalledOnce();
});

it("drains library work without cancelling or waiting for a late POST; reused IDs cannot target the replacement", async () => {
  const original = directory;
  const started = deferred<void>();
  const reply = deferred<Response>();
  generationPost.mockImplementationOnce(() => {
    started.resolve();
    return reply.promise;
  });
  const input = imageInput();
  const submitting = submitJob(input);
  const retired = expect(submitting).rejects.toThrow();
  await started.promise;
  await service.suspend();
  await openFixture();
  service.reset();
  reply.resolve(acknowledged());
  await retired;
  expect(await service.get({ id: input.id }, profile.capture())).toBeNull();
  expect(await manager.get().select().from(clips)).toEqual([]);
  await service.suspend();
  directory = original;
  await manager.open(directory);
  service = newService();
  expect(await service.get({ id: input.id }, profile.capture())).toMatchObject({
    status: "SUBMISSION_UNKNOWN"
  });
  await service.recover();
  expect(generationPost).toHaveBeenCalledOnce();
  expect(
    fetchMock.mock.calls.some(([url]) => fetchUrl(url).endsWith("/cancel"))
  ).toBe(false);
});

it("ignores a late result across an ABA profile change, then polls normally in the current epoch", async () => {
  const input = imageInput();
  await submitJob(input);
  const started = deferred<void>();
  const reply = deferred<Response>();
  const baseFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (request, init) => {
    if (
      fetchUrl(request).endsWith("/requests/request-1") &&
      init?.method === "GET"
    ) {
      started.resolve();
      return reply.promise;
    }
    return baseFetch(request, init);
  });
  const recovering = service.recover();
  await started.promise;
  profile.rotate();
  profile.rotate();
  await recovering;
  reply.resolve(Response.json({ images: [{ url: outputUrl }] }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await service.get({ id: input.id }, profile.capture())).toMatchObject({
    status: "SUBMITTED"
  });
  expect(await manager.get().select().from(clips)).toHaveLength(0);
  expect(
    fetchMock.mock.calls.some(([request]) => fetchUrl(request) === outputUrl)
  ).toBe(false);
  fetchMock.mockImplementation(baseFetch);
  await service.recover();
  expect(await service.get({ id: input.id }, profile.capture())).toMatchObject({
    status: "INGESTED",
    placement: "ATTACHED"
  });
  expect(generationPost).toHaveBeenCalledOnce();
});
const effectInput = () => ({
  id: randomUUID(),
  projectId,
  shotId,
  sourceClipId: "source-clip",
  expectedSourceAssetId: "source",
  kind: "video-edit" as const,
  model: FAL_KLING_EDIT,
  prompt: "Adjust the lighting",
  keepAudio: true,
  referenceAssetIds: ["ref", "base"]
});

async function seedEffectSource(
  override: Partial<typeof clips.$inferInsert> = {}
) {
  const source = path.join(directory, "source.mov");
  await writeFile(source, "video fixture");
  await manager
    .get()
    .update(projects)
    .set({ settingsJson: '{"origin":"local"}' })
    .where(eq(projects.id, projectId));
  await manager.get().insert(assets).values({
    id: "source",
    name: "Original",
    type: "video",
    sourcePath: source,
    frameCount: 168
  });
  await manager
    .get()
    .insert(projectAssets)
    .values({ projectId, assetId: "source" });
  await manager
    .get()
    .insert(clips)
    .values({
      id: "source-clip",
      trackId,
      assetId: "source",
      name: "Original",
      timelineOffset: 1000,
      ...override
    });
  outputKind = "video";
  return source;
}

it("sends a whole MOV and ordered local stills to Kling, then adds a separate aligned layer", async () => {
  await seedEffectSource();
  const input = effectInput();
  const before = await manager.get().select().from(clips);
  expect(await submitJob(input)).toMatchObject({
    status: "SUBMITTED",
    placement: "PENDING"
  });
  expect(generationEndpoint).toBe("/fal-ai/kling-video/o1/video-to-video/edit");
  expect(probeEffectVideo).toHaveBeenCalledWith(
    expect.stringMatching(/mago-effect-.+[\/]source\.mov$/),
    expect.any(AbortSignal)
  );
  expect(payload).toEqual({
    video_url: "https://v3.fal.media/input-1",
    image_urls: [
      "https://v3.fal.media/input-2",
      "https://v3.fal.media/input-3"
    ],
    prompt: input.prompt,
    keep_audio: true
  });
  await service.recover();
  await service.recover();
  const job = await service.get({ id: input.id }, profile.capture());
  expect(job).toMatchObject({ status: "INGESTED", placement: "ATTACHED" });
  const rows = await manager.get().select().from(clips);
  expect(rows).toHaveLength(2);
  expect(rows.filter(({ id }) => id === input.sourceClipId)).toEqual(before);
  const placed = rows.find(({ id }) => id === job?.clipId)!;
  expect(placed).toMatchObject({ timelineOffset: 1000 });
  expect(JSON.parse(placed.dataJson).frame_range).toEqual([24, 192]);
  expect(placed.trackId).not.toBe(trackId);
  expect(generationPost).toHaveBeenCalledTimes(1);
});

it("resumes Topaz by request ID without its original file and retains mismatched output in local history", async () => {
  const source = await seedEffectSource();
  const {
    id,
    projectId: p,
    shotId: s,
    sourceClipId,
    expectedSourceAssetId
  } = effectInput();
  const input = {
    id,
    projectId: p,
    shotId: s,
    sourceClipId,
    expectedSourceAssetId,
    kind: "video-upscale",
    model: FAL_TOPAZ_UPSCALE
  } as const;
  expect(await submitJob(input)).toMatchObject({
    status: "SUBMITTED"
  });
  expect(generationEndpoint).toBe("/fal-ai/topaz/upscale/video");
  expect(payload).toEqual({
    video_url: "https://v3.fal.media/input-1",
    model: "Proteus",
    upscale_factor: 2,
    H264_output: true
  });
  await rm(source);
  await service.suspend();
  service = newService();
  await service.recover();
  expect(await service.get({ id }, profile.capture())).toMatchObject({
    status: "INGESTED",
    placement: "UNATTACHED",
    warning: expect.stringContaining("history"),
    assetIds: [expect.any(String)],
    clipId: null
  });
  expect(generationPost).toHaveBeenCalledTimes(1);
  expect(
    vi
      .mocked(probeEffectVideo)
      .mock.calls.filter(([file]) => file.endsWith("source.mov"))
  ).toHaveLength(1);
  expect(await manager.get().select().from(clips)).toHaveLength(1);
});

it("rejects trimmed, foreign and unsupported effects without Keychain, uploads or local inference", async () => {
  await seedEffectSource({ trimStart: 800 });
  const input = effectInput();
  await expect(submitRequest(input)).resolves.toMatchObject({
    status: "rejected",
    message: expect.stringMatching(/entire source/)
  });
  await expect(
    submitRequest({ ...input, sourceClipId: "foreign" })
  ).resolves.toMatchObject({
    status: "rejected",
    message: expect.stringMatching(/local video clip/)
  });
  await expect(
    submitRequest({ ...input, model: "remote-pose" })
  ).resolves.toMatchObject({ status: "rejected" });
  expect(readKey).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await manager.get().select().from(ordinaryFalJobs)).toEqual([]);
});
it("uploads the probed snapshot and removes it before the paid render request", async () => {
  const linkedFile = await seedEffectSource();
  const probe = vi.mocked(probeEffectVideo);
  const fixture = probe.getMockImplementation()!;
  let snapshot = "";
  probe.mockImplementationOnce(async (file, signal) => {
    snapshot = file;
    expect(await readFile(file, "utf8")).toBe("video fixture");
    await writeFile(linkedFile, "replacement footage");
    return fixture(file, signal);
  });
  const transport = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (request, init) => {
    if (
      fetchUrl(request) === "https://fixture.invalid/put-1" &&
      init?.method === "PUT"
    ) {
      expect(init.body).toBeInstanceOf(Blob);
      expect(await (init.body as Blob).text()).toBe("video fixture");
    }
    if (
      fetchUrl(request).startsWith("https://queue.fal.run/") &&
      init?.method === "POST"
    ) {
      await expect(stat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
    }
    return transport(request, init);
  });
  const input = effectInput();
  await expect(
    submitRequest({ ...input, expectedSourceAssetId: "replacement" })
  ).resolves.toMatchObject({
    status: "rejected",
    message: expect.stringMatching(/source clip changed/)
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await submitJob(input)).toMatchObject({ status: "SUBMITTED" });
  expect(await readFile(linkedFile, "utf8")).toBe("replacement footage");
  await expect(stat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses presentation timing for placement and leaves a timing mismatch unattached", async () => {
  await seedEffectSource();
  const input = effectInput();
  const probe = vi.mocked(probeEffectVideo);
  const fixture = probe.getMockImplementation()!;
  probe
    .mockImplementationOnce(fixture)
    .mockImplementationOnce(async (file, signal) => ({
      ...(await fixture(file, signal)),
      durationSeconds: 7.02,
      fps: 168 / 7.02
    }));
  await submitJob(input);
  await service.recover();
  expect(await service.get({ id: input.id }, profile.capture())).toMatchObject({
    status: "INGESTED",
    placement: "UNATTACHED"
  });
  expect(await manager.get().select().from(clips)).toHaveLength(1);
});

it("keeps older effects jobs without a source timing signature unattached", async () => {
  await seedEffectSource();
  const input = effectInput();
  await submitJob(input);
  const [reservation] = await manager.get().select().from(ordinaryFalJobs);
  const { destination } = reservation;
  if (destination.kind !== "video-edit") throw new Error("Expected an edit");
  await manager
    .get()
    .update(ordinaryFalJobs)
    .set({
      destination: {
        ...destination,
        source: { ...destination.source, presentationSignature: undefined }
      }
    })
    .where(eq(ordinaryFalJobs.jobId, reservation.jobId));
  await service.suspend();
  service = newService();
  await service.recover();
  expect(await service.get({ id: input.id }, profile.capture())).toMatchObject({
    status: "INGESTED",
    placement: "UNATTACHED",
    assetIds: [expect.any(String)],
    clipId: null
  });
  expect(await manager.get().select().from(clips)).toHaveLength(1);
});

it.skipIf(!ffmpegPath)(
  "keeps a CFR result in history when the VFR source has the same count and duration",
  async () => {
    const source = await seedEffectSource();
    const output = path.join(directory, "cfr.mp4");
    const run = promisify(execFile);
    await run(ffmpegPath!, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=s=1280x768:r=48:d=7",
      // Keep every other frame, except move the second and final frames by one tick.
      "-vf",
      "select='not(mod(n,2))+eq(n,1)-eq(n,2)+eq(n,335)-eq(n,334)'",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      "-bf",
      "0",
      source
    ]);
    await run(ffmpegPath!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=s=1280x768:r=24:d=7",
      "-c:v",
      "libx264",
      "-bf",
      "0",
      output
    ]);
    const actual =
      await vi.importActual<typeof import("./probeEffectVideo")>(
        "./probeEffectVideo"
      );
    const vfr = await actual.probeEffectVideo(source);
    const cfr = await actual.probeEffectVideo(output);
    for (const metadata of [vfr, cfr]) {
      expect(metadata).toMatchObject({
        durationSeconds: 7,
        fps: 24,
        width: 1280,
        height: 768,
        hasAudio: false
      });
    }
    expect(vfr.presentationSignature).not.toBe(cfr.presentationSignature);
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (request, init) =>
      fetchUrl(request) === outputUrl
        ? new Response(await readFile(output))
        : transport(request, init)
    );
    const input = effectInput();
    await vi
      .mocked(probeEffectVideo)
      .withImplementation(actual.probeEffectVideo, async () => {
        await submitJob(input);
        await service.recover();
      });
    const job = await service.get({ id: input.id }, profile.capture());
    expect(job).toMatchObject({
      status: "INGESTED",
      placement: "UNATTACHED",
      warning: expect.stringContaining("history"),
      assetIds: [expect.any(String)],
      clipId: null
    });
    const [asset] = await manager
      .get()
      .select()
      .from(assets)
      .where(eq(assets.id, job!.assetIds[0]));
    expect(asset).toMatchObject({
      duration: 7000,
      fps: 24000,
      frameCount: 168
    });
    expect(await readFile(asset.sourcePath)).toEqual(await readFile(output));
    expect(await manager.get().select().from(clips)).toHaveLength(1);
  }
);
