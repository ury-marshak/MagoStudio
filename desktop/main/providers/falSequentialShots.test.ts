import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FAL_SHOT_PROVIDER } from "../../shared/falShotModel";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { ScriptProjectSnapshotRepository } from "../database/scriptProjectSnapshotRepository";
import * as media from "../scriptProjects/localScriptMedia";
import { LocalScriptProjectService } from "../scriptProjects/localScriptProjectService";
import { fingerprint } from "../scriptProjects/renderSpec";
import { defaultSequentialAppendix } from "../scriptProjects/shots/sequentialContinuation";
import { sceneFingerprint } from "../scriptProjects/storyboards/storyboard";

import { ExternalRenderAssets } from "./externalRenderAssets";
import { ExternalRenderJobRepository } from "./externalRenderJobRepository";
import { ExternalRenderJobService } from "./externalRenderJobService";
import { FalRenderProvider } from "./falRenderProvider";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 64, height: 48 })
    })
  }
}));

vi.mock("../media/imageThumbnail", () => ({
  createImageThumbnail: async (_source: string, destination: string) => {
    await writeFile(destination, "thumbnail");
  }
}));

type Row = Record<string, unknown>;
const rows = (value: unknown) => value as Row[];
const row = (value: unknown) => value as Row;
const queue = "https://queue.fal.run/minimax/h3-max/reference-to-video";
const requestRoot = "https://queue.fal.run/minimax/h3-max/requests/";
const storage =
  "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const cdn = "https://v3.fal.media";

let directory: string;
let manager: DatabaseManager;
let projects: ProjectRepository;
let snapshots: ScriptProjectSnapshotRepository;
let projectId: string;
let jobs: ExternalRenderJobRepository;
let director: LocalScriptProjectService;
let source: { id: string; path: string; url: string };
let hero: { id: string; path: string; url: string };
let video: Buffer;
let png: Buffer;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let getComfyEndpoint: ReturnType<typeof vi.fn<() => Promise<string>>>;
let external: ReturnType<
  typeof vi.fn<
    (request: {
      userPrompt: string;
    }) => Promise<{ model: string; text: string }>
  >
>;
let offline: boolean;
let submissions: Array<{ requestId: string; body: Row }>;
let uploadIds: string[];
let uploaded: Map<string, Buffer>;
let unexpected: string[];

const makeDirector = () =>
  new LocalScriptProjectService(
    projects,
    snapshots,
    getComfyEndpoint,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => external,
    new ExternalRenderJobService(
      new ExternalRenderJobRepository(manager),
      new Map([
        [
          "fal",
          new FalRenderProvider(
            async () => ({ keychainAccount: "mock-fal" }),
            async () => "mock-key"
          )
        ]
      ]),
      new ExternalRenderAssets(
        manager,
        async () => directory,
        (id, project) => snapshots.resolveMediaPath(id, project)
      )
    )
  );

const shot = (index: number, extra: Row = {}): Row => ({
  timeline_id: `shot-${index}`,
  shot_index: index - 1,
  sequence_id: index,
  key: String(index),
  video_prompt: "<Picture 1> keeps walking.",
  duration_s: 5,
  tags: { characters: ["hero"] },
  references: { characters: [{ token: "hero", asset_id: hero.id }] },
  missing_references: [],
  ...extra
});

const seed = async (config: Row, extraShots: Row[] = []) => {
  await snapshots.put({
    projectId,
    state: {
      keys: [{ token: "hero", name: "Hero", description: "A courier." }],
      shots: [
        // Deliberately shorter than the successor, and not the default 24 fps.
        shot(1, { duration_s: 1 }),
        shot(2, { sequential: { enabled: true, ...config } }),
        ...extraShots
      ]
    },
    cut: {
      project_id: projectId,
      shots: [
        {
          timeline_id: "shot-1",
          sequence_id: 1,
          asset_id: source.id,
          pinned_asset_id: source.id,
          versions: [{ asset_id: source.id, url: source.url, ready: true }]
        },
        ...[2, ...extraShots.map((item) => Number(item.sequence_id))].map(
          (index) => ({
            timeline_id: `shot-${index}`,
            sequence_id: index,
            versions: []
          })
        )
      ]
    }
  });
};

const request = (rewrite = "raw", timelineIds = ["shot-2"]) => ({
  projectId,
  isDryRun: false,
  timelineIds,
  videoSettings: { render_provider: FAL_SHOT_PROVIDER, prompt_rewrite: rewrite }
});

const waitPlan = async (planId: string, status: string) => {
  await vi.waitFor(
    async () => {
      expect(await director.getPlan(planId)).toMatchObject({ status });
    },
    { timeout: 10000, interval: 20 }
  );
  return (await director.getPlan(planId))!;
};

const step = (plan: Row, tool: string, timelineId = "shot-2") =>
  rows(plan.steps).find(
    (item) => item.tool_name === tool && item.timeline_id === timelineId
  )!;

const cutShots = async () => rows((await snapshots.get(projectId))!.cut!.shots);
const version = async (timelineId = "shot-2") =>
  rows(
    (await cutShots()).find((item) => item.timeline_id === timelineId)!.versions
  ).at(-1)!;
const jobFor = async (plan: Row, timelineId = "shot-2") =>
  (await jobs.get(String(step(plan, "submit_video_render", timelineId).id)))!;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mago-fal-sequential-"));
  manager = new DatabaseManager();
  await manager.open(directory);
  projects = new ProjectRepository(manager, async () => directory);
  projectId = (
    await projects.create({
      name: "Sequential fal integration",
      description: "",
      settings: { type: "script_to_shots" }
    })
  ).id;
  snapshots = new ScriptProjectSnapshotRepository(
    manager,
    async () => directory
  );
  jobs = new ExternalRenderJobRepository(manager);
  const filename = path.join(directory, "fixture.mp4");
  execFileSync(ffmpegPath!, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x48:rate=12",
    "-t",
    "1",
    "-pix_fmt",
    "yuv420p",
    filename
  ]);
  video = await readFile(filename);
  png = await media.extractFirstFrame(filename);
  source = await snapshots.storeGeneratedMedia(projectId, video, "mp4");
  hero = await snapshots.storeGeneratedMedia(projectId, png, "png");
  getComfyEndpoint = vi.fn(async () => {
    throw new Error("ComfyUI must not be used");
  });
  external = vi.fn(async (_request: { userPrompt: string }) => ({
    model: "mock/composer",
    text: JSON.stringify({
      subject_definitions:
        "{{subject:hero}} is the courier in {{ref:hero}}. {{ref:prev_shot}} shows the preceding moment.",
      summary: "[reference generation] The courier keeps walking.",
      retention_analysis:
        "{{ref:hero}}: weak_reference - courier appearance. {{ref:prev_shot}}: weak_reference - continuity.",
      detailed_description: "[Shot 1] The courier keeps walking by the door.",
      overall_soundscape: "Room tone.",
      non_diegetic_music: "N/A"
    })
  }));
  offline = false;
  submissions = [];
  uploadIds = [];
  uploaded = new Map();
  unexpected = [];
  // Strict local transport: the real provider and upload/download services run,
  // but no URL can ever reach the network (including unexpected requests).
  fetchMock = vi.fn<typeof fetch>(async (target, options) => {
    const url =
      typeof target === "string"
        ? target
        : target instanceof URL
          ? target.href
          : target.url;
    if (url === storage && options?.method === "POST") {
      if (typeof options.body !== "string")
        throw new Error("Expected upload initiation JSON");
      const body = JSON.parse(options.body) as { file_name: string };
      const id = path.basename(body.file_name, ".png");
      uploadIds.push(id);
      return Response.json({
        file_url: `${cdn}/input/${id}.png`,
        upload_url: `${cdn}/upload/${id}`
      });
    }
    if (url.startsWith(`${cdn}/upload/`) && options?.method === "PUT") {
      const body = options.body;
      if (!(body instanceof Blob))
        throw new Error("Expected a PNG upload Blob");
      uploaded.set(
        url.slice(`${cdn}/upload/`.length),
        Buffer.from(await body.arrayBuffer())
      );
      return new Response(null);
    }
    if (url === queue && options?.method === "POST") {
      if (typeof options.body !== "string")
        throw new Error("Expected render JSON");
      const requestId = `mock-request-${submissions.length + 1}`;
      submissions.push({ requestId, body: JSON.parse(options.body) as Row });
      return Response.json({ request_id: requestId, status: "IN_QUEUE" });
    }
    if (url.startsWith(requestRoot) && options?.method === "GET") {
      const id = url.slice(requestRoot.length).split("/")[0]!;
      if (submissions.some((item) => item.requestId === id)) {
        if (url.endsWith("/status")) {
          if (offline) throw new Error("connection lost after acceptance");
          return Response.json({ status: "COMPLETED", request_id: id });
        }
        if (url === `${requestRoot}${id}`)
          return Response.json({
            video: { url: `${cdn}/output/${id}.mp4` },
            seed: 42,
            reference_tokens: 12
          });
      }
    }
    if (
      submissions.some((item) => url === `${cdn}/output/${item.requestId}.mp4`)
    )
      return new Response(new Uint8Array(video));
    unexpected.push(`${options?.method ?? "GET"} ${url}`);
    throw new Error(`Unexpected mocked fetch: ${unexpected.at(-1)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  director = makeDirector();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  manager.close();
  await rm(directory, { recursive: true, force: true });
  expect(unexpected).toEqual([]);
  expect(getComfyEndpoint).not.toHaveBeenCalled();
});

describe("fal sequential frame integration", () => {
  it.each(["cut", "off"])(
    "submits last_frame/%s with continuity last and persists the actual predecessor",
    async (openingFrame) => {
      await seed({ mode: "last_frame", opening_frame: openingFrame });
      const extract = vi.spyOn(media, "extractLastFrame");
      const generated = await director.generateShots(request("mago"));
      const plan = await waitPlan(String(generated.plan_id), "COMPLETED");
      const frame = row(step(plan, "use_provided_reference_frame").result);
      const provenance = {
        timeline_id: "shot-1",
        asset_id: source.id,
        mode: "last_frame",
        reference_asset_id: frame.shot_reference_image_id
      };
      expect(rows(plan.local_targets)[0]).toMatchObject({
        _local_previous_asset_id: source.id
      });
      expect(extract).toHaveBeenCalledExactlyOnceWith(
        source.path,
        expect.any(AbortSignal)
      );
      expect(frame).toMatchObject({
        mode: "last_frame",
        selection: {
          mode: "last_frame",
          prompt_appendix: defaultSequentialAppendix(
            "last_frame",
            openingFrame
          ),
          ...(openingFrame === "off" ? { opening_frame: "off" } : {})
        },
        source_frame_count: null,
        source_fps: null,
        continues_from: provenance
      });
      const job = await jobFor(plan);
      expect(job.inputAssetIds).toEqual([
        hero.id,
        frame.shot_reference_image_id
      ]);
      expect(uploadIds).toEqual(job.inputAssetIds);
      expect(uploaded.get(String(frame.shot_reference_image_id))).toEqual(
        await extract.mock.results[0]!.value
      );
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.body).toMatchObject({
        duration: 5,
        reference_image_urls: job.inputAssetIds.map(
          (id) => `${cdn}/input/${id}.png`
        ),
        prompt: expect.stringContaining("Image 2"),
        prompt_expansion_mode: "disabled"
      });
      expect(submissions[0]!.body.prompt).not.toMatch(/<Picture/);
      expect(external).toHaveBeenCalledTimes(1);
      const rendered = await version();
      expect(rendered).toMatchObject({
        ready: true,
        continues_from: provenance,
        metrics_input: {
          reference_asset_ids: job.inputAssetIds,
          prompt: job.requestJson.prompt
        },
        render_spec: { sequential: { prev_asset_id: source.id } },
        input_settings: {
          provider: "fal",
          duration_s: 5,
          measured_duration_s: 1,
          seed: 42,
          reference_tokens: 12
        }
      });
      expect(rendered.fingerprint).toBe(fingerprint(row(rendered.render_spec)));
      expect(
        row(step(plan, "poll_video_render").result).continues_from
      ).toEqual(provenance);
    }
  );

  it.each([1, 4])(
    "extracts %i keyframes using the one-second predecessor's actual frame count and FPS",
    async (count) => {
      await seed({ mode: "key_frames", num_select: count });
      const snapshot = (await snapshots.get(projectId))!;
      const successor = rows(snapshot.state!.shots)[1]!;
      successor.references = {};
      successor.tags = {};
      successor.video_prompt = "Continue the action.";
      await snapshots.put({ projectId, state: snapshot.state! });
      const extract = vi.spyOn(media, "extractKeyframeGrid");
      const generated = await director.generateShots(request());
      const plan = await waitPlan(String(generated.plan_id), "COMPLETED");
      expect(extract).toHaveBeenCalledExactlyOnceWith(
        source.path,
        1,
        count,
        expect.any(AbortSignal),
        12
      );
      const frame = row(step(plan, "poll_pick_keyframes").result);
      expect(frame).toMatchObject({
        mode: "key_frames",
        selection: { mode: "key_frames", num_select: count },
        source_frame_count: 12,
        source_fps: 12,
        continues_from: {
          asset_id: source.id,
          mode: "key_frames",
          reference_asset_id: frame.shot_reference_image_id
        }
      });
      const bytes = uploaded.get(String(frame.shot_reference_image_id))!;
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      // PNG IHDR proves we got every selected tile, not black EOF samples from
      // the successor's requested five-second duration.
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([
        512 * count + 4 * (count - 1),
        384
      ]);
      const job = await jobFor(plan);
      expect(job.inputAssetIds).toEqual([frame.shot_reference_image_id]);
      expect(job.requestJson.duration).toBe(5);
      expect((await version()).continues_from).toEqual(frame.continues_from);
      expect(external).not.toHaveBeenCalled();
    }
  );

  it("recovers an accepted request without rereading a changed pin, extracting, uploading or composing again", async () => {
    await seed({ mode: "key_frames", num_select: 4 }, [shot(3)]);
    const extract = vi.spyOn(media, "extractKeyframeGrid");
    offline = true;
    const generated = await director.generateShots(
      request("mago", ["shot-2", "shot-3"])
    );
    const planId = String(generated.plan_id);
    const paused = await waitPlan(planId, "PAUSED");
    const frame = structuredClone(
      row(step(paused, "poll_pick_keyframes").result)
    );
    const accepted = await jobFor(paused);
    expect(accepted).toMatchObject({
      status: "SUBMITTED",
      requestId: "mock-request-1"
    });
    expect(external).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(frame).toMatchObject({ source_frame_count: 12, source_fps: 12 });

    const replacement = await snapshots.storeGeneratedMedia(
      projectId,
      Buffer.concat([video, Buffer.from("changed pin")]),
      "mp4"
    );
    const snapshot = (await snapshots.get(projectId))!;
    const previous = rows(snapshot.cut!.shots)[0]!;
    previous.asset_id = replacement.id;
    previous.pinned_asset_id = replacement.id;
    rows(previous.versions).push({
      asset_id: replacement.id,
      url: replacement.url,
      ready: true
    });
    await snapshots.put({ projectId, cut: snapshot.cut! });
    await rm(source.path);
    await rm(
      (await snapshots.resolveMediaPath(
        String(frame.shot_reference_image_id),
        projectId
      ))!
    );
    // Even reference images are no longer needed once the provider accepted.
    await rm(hero.path);
    const beforeRecovery = fetchMock.mock.calls.length;
    manager.close();
    await manager.open(directory);
    director = makeDirector();
    offline = false;
    await director.recoverExternalRenderPlans();
    await vi.waitFor(
      async () => {
        expect(await director.getPlan(planId)).toMatchObject({
          status: "PAUSED",
          steps: expect.arrayContaining([
            expect.objectContaining({
              timeline_id: "shot-2",
              tool_name: "poll_video_render",
              status: "COMPLETED"
            }),
            expect.objectContaining({
              timeline_id: "shot-3",
              tool_name: "submit_video_render",
              status: "PENDING"
            })
          ])
        });
      },
      { timeout: 10000, interval: 20 }
    );
    const recovered = (await director.getPlan(planId))!;
    expect(
      fetchMock.mock.calls
        .slice(beforeRecovery)
        .map(([target, options]) => [target, options?.method ?? "GET"])
    ).toEqual([
      [`${requestRoot}${accepted.requestId}/status`, "GET"],
      [`${requestRoot}${accepted.requestId}`, "GET"],
      [`${cdn}/output/${accepted.requestId}.mp4`, "GET"]
    ]);
    expect(await jobFor(recovered)).toMatchObject({
      status: "INGESTED",
      requestId: accepted.requestId,
      inputAssetIds: accepted.inputAssetIds,
      requestJson: accepted.requestJson
    });
    expect(row(step(recovered, "poll_pick_keyframes").result)).toEqual(frame);
    expect(external).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(submissions).toHaveLength(1);
    const rendered = await version();
    expect(rendered).toMatchObject({
      continues_from: frame.continues_from,
      sent_prompt: accepted.requestJson.prompt,
      metrics_input: {
        prompt: accepted.requestJson.prompt,
        duration_s: 5,
        reference_asset_ids: accepted.inputAssetIds
      },
      render_spec: { sequential: { prev_asset_id: source.id } },
      input_settings: {
        provider_settings: accepted.requestJson,
        seed: 42,
        reference_tokens: 12
      }
    });
    expect(rendered.fingerprint).toBe(fingerprint(row(rendered.render_spec)));
    expect(rows((await cutShots())[2]!.versions)).toEqual([]);
    expect(
      await jobs.get(
        String(step(recovered, "submit_video_render", "shot-3").id)
      )
    ).toBeNull();
  });

  it("grids overflowing references without dropping any and numbers storyboard before continuity within nine slots", async () => {
    await seed({ mode: "last_frame", opening_frame: "cut" });
    const props = await Promise.all(
      Array.from({ length: 9 }, async (_, index) => {
        // Distinct valid PNGs; FFmpeg ignores the trailing fixture identifier.
        const image = await snapshots.storeGeneratedMedia(
          projectId,
          Buffer.concat([png, Buffer.from(`prop-${index}`)]),
          "png"
        );
        return { token: `prop-${index}`, asset_id: image.id };
      })
    );
    const board = await snapshots.storeGeneratedMedia(
      projectId,
      Buffer.concat([png, Buffer.from("storyboard")]),
      "png"
    );
    const snapshot = (await snapshots.get(projectId))!;
    const successor = rows(snapshot.state!.shots)[1]!;
    successor.references = {
      characters: [{ token: "hero", asset_id: hero.id }],
      props
    };
    successor.tags = {
      characters: ["hero"],
      props: props.map((item) => item.token)
    };
    const keys = rows(snapshot.state!.keys);
    keys.push(
      ...props.map((item) => ({
        token: item.token,
        name: item.token,
        description: "A parcel."
      }))
    );
    keys.push({
      token: "storyboard_shot_2",
      role: "storyboard",
      timeline_id: "shot-2",
      images: [
        {
          asset_id: board.id,
          status: "available",
          panel_count: 1,
          storyboard_scene_fingerprint: sceneFingerprint(successor, keys)
        }
      ]
    });
    await snapshots.put({ projectId, state: snapshot.state! });
    const grid = vi.spyOn(media, "createReferenceGrid");
    const generated = await director.generateShots(request("mago"));
    const plan = await waitPlan(String(generated.plan_id), "COMPLETED");
    const stitched = row(step(plan, "poll_stitch_refs").result);
    const frame = row(step(plan, "use_provided_reference_frame").result);
    const job = await jobFor(plan);
    expect(grid).toHaveBeenCalledTimes(1);
    // Hero + five individual props + a grid of the last four props + board + frame.
    expect(stitched.members).toEqual(
      props.slice(5).map((item) => item.asset_id)
    );
    expect(job.inputAssetIds).toEqual([
      hero.id,
      ...props.slice(0, 5).map((item) => item.asset_id),
      stitched.asset_id,
      board.id,
      frame.shot_reference_image_id
    ]);
    expect(job.inputAssetIds).toHaveLength(9);
    expect(uploadIds).toEqual(job.inputAssetIds);
    expect(submissions[0]!.body.reference_image_urls).toEqual(
      job.inputAssetIds.map((id) => `${cdn}/input/${id}.png`)
    );
    const composed = row(step(plan, "poll_shot_video_prompt").result);
    expect(composed.numbered_ref_asset_ids).toEqual(job.inputAssetIds);
    expect(composed.fallback).toBe(false);
    expect(job.requestJson.prompt).toContain(
      "Stage this shot as panel 1 of Image 8"
    );
    expect(job.requestJson.prompt).toContain("Image 9");
    expect(job.requestJson.prompt).not.toMatch(/Image 10|<Picture/);
    expect((await version()).metrics_input).toMatchObject({
      reference_asset_ids: job.inputAssetIds
    });
  });

  it("uses the newly finished same-run predecessor instead of its old ready pin, then dry-runs as a no-op", async () => {
    await seed({ mode: "last_frame", opening_frame: "off" });
    const snapshot = (await snapshots.get(projectId))!;
    rows(snapshot.state!.shots)[0]!.duration_s = 5;
    await snapshots.put({ projectId, state: snapshot.state! });
    const extract = vi.spyOn(media, "extractLastFrame");
    const input = request("raw", ["shot-1", "shot-2"]);
    const generated = await director.generateShots(input);
    const plan = await waitPlan(String(generated.plan_id), "COMPLETED");
    const target = rows(plan.local_targets).find(
      (item) => item.timeline_id === "shot-2"
    )!;
    expect(target).toMatchObject({
      _local_previous_asset_id: null,
      _local_previous_in_run: true
    });
    expect(step(plan, "poll_prev_shot_complete").status).toBe("COMPLETED");
    const predecessor = await version("shot-1");
    expect(predecessor.asset_id).not.toBe(source.id);
    const current = await version();
    expect(current).toMatchObject({
      continues_from: { timeline_id: "shot-1", asset_id: predecessor.asset_id },
      render_spec: { sequential: { prev_asset_id: predecessor.asset_id } }
    });
    expect(extract).toHaveBeenCalledExactlyOnceWith(
      await snapshots.resolveMediaPath(String(predecessor.asset_id), projectId),
      expect.any(AbortSignal)
    );
    expect(current.fingerprint).toBe(fingerprint(row(current.render_spec)));
    expect(submissions).toHaveLength(2);
    const callsBeforePreview = fetchMock.mock.calls.length;
    const preview = await director.generateShots({ ...input, isDryRun: true });
    expect(preview.would_run_timeline_ids).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforePreview);
  });

  it("pauses on a missing predecessor source before any upload or paid submission", async () => {
    await seed({ mode: "last_frame", opening_frame: "cut" });
    await rm(source.path);
    const generated = await director.generateShots(request());
    const plan = await waitPlan(String(generated.plan_id), "PAUSED");
    expect(step(plan, "use_provided_reference_frame")).toMatchObject({
      status: "FAILED",
      error: {
        message: expect.stringContaining("Unable to extract continuity image")
      }
    });
    expect(
      await jobs.get(String(step(plan, "submit_video_render").id))
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(rows((await cutShots())[1]!.versions)).toEqual([]);
  });

  it("cancels during frame preparation without uploading or submitting a render", async () => {
    await seed({ mode: "last_frame", opening_frame: "cut" });
    // Hold only the extraction boundary, deterministically cancelling before
    // upload instead of racing a short-lived FFmpeg process.
    const extract = vi.spyOn(media, "extractLastFrame").mockImplementation(
      async (_filename, signal) =>
        new Promise<Buffer>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true }
          );
        })
    );
    const generated = await director.generateShots(request());
    const planId = String(generated.plan_id);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    await director.cancelPlan(planId);
    const plan = await waitPlan(planId, "CANCELLED");
    expect(extract.mock.calls[0]![1]!.aborted).toBe(true);
    expect(
      await jobs.get(String(step(plan, "submit_video_render").id))
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(rows((await cutShots())[1]!.versions)).toEqual([]);
  });

  it("composes a portrait shot using the saved 9:16 provider aspect ratio", async () => {
    await seed({ mode: "last_frame", opening_frame: "cut" });
    const input = request("mago");
    const generated = await director.generateShots({
      ...input,
      videoSettings: {
        ...input.videoSettings,
        provider_settings: { aspect_ratio: "9:16" }
      }
    });
    const plan = await waitPlan(String(generated.plan_id), "COMPLETED");
    expect(external).toHaveBeenCalledTimes(1);
    expect(external.mock.calls[0]![0].userPrompt).toContain("9:16");
    expect(row(step(plan, "poll_shot_video_prompt").result)).toMatchObject({
      text_model_route: "external",
      fallback: false
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.body.aspect_ratio).toBe("9:16");
    expect((await jobFor(plan)).requestJson.aspect_ratio).toBe("9:16");
    expect(
      row(row(plan.local_request).videoSettings).provider_settings
    ).toMatchObject({
      aspect_ratio: "9:16"
    });
    expect(await version()).toMatchObject({
      render_spec: {
        settings: { provider_settings: { aspect_ratio: "9:16" } }
      },
      input_settings: {
        aspect_ratio: "9:16",
        provider_settings: { aspect_ratio: "9:16" }
      }
    });
  });

  it("continues from the same-run poll result even when its finished predecessor is repinned to the old source", async () => {
    await seed({ mode: "last_frame", opening_frame: "off" });
    const snapshot = (await snapshots.get(projectId))!;
    rows(snapshot.state!.shots)[0]!.duration_s = 5;
    await snapshots.put({ projectId, state: snapshot.state! });
    const extract = vi.spyOn(media, "extractLastFrame");
    const putPlan = snapshots.putPlan.bind(snapshots);
    let repinned = false;
    let predecessorId: string | undefined;
    vi.spyOn(snapshots, "putPlan").mockImplementation(
      async (project, id, plan) => {
        await putPlan(project, id, plan);
        const completed = step(plan, "poll_video_render", "shot-1");
        if (!repinned && completed?.status === "COMPLETED") {
          repinned = true;
          predecessorId = String(row(completed.result).render_asset_id);
          // Simulate a user changing the cut pin after this run finishes shot 1,
          // but before it prepares the sequential reference for shot 2.
          const current = (await snapshots.get(projectId))!;
          const predecessor = rows(current.cut!.shots)[0]!;
          predecessor.pinned_asset_id = source.id;
          predecessor.asset_id = source.id;
          predecessor.url = source.url;
          await snapshots.put({ projectId, cut: current.cut! });
        }
      }
    );
    const generated = await director.generateShots(
      request("raw", ["shot-1", "shot-2"])
    );
    const plan = await waitPlan(String(generated.plan_id), "COMPLETED");
    expect(repinned).toBe(true);
    expect(predecessorId).toBeTruthy();
    expect(predecessorId).not.toBe(source.id);
    expect(
      row(step(plan, "poll_video_render", "shot-1").result).render_asset_id
    ).toBe(predecessorId);
    expect((await cutShots())[0]).toMatchObject({
      asset_id: source.id,
      pinned_asset_id: source.id
    });
    expect(extract).toHaveBeenCalledExactlyOnceWith(
      await snapshots.resolveMediaPath(predecessorId!, projectId),
      expect.any(AbortSignal)
    );
    expect(
      row(step(plan, "use_provided_reference_frame").result)
    ).toMatchObject({
      continues_from: { asset_id: predecessorId, timeline_id: "shot-1" }
    });
    const current = await version();
    expect(current).toMatchObject({
      continues_from: { asset_id: predecessorId, timeline_id: "shot-1" },
      render_spec: { sequential: { prev_asset_id: predecessorId } }
    });
    expect(current.fingerprint).toBe(fingerprint(row(current.render_spec)));
    expect(submissions).toHaveLength(2);
  });

  const nineReferences = async () => ({
    characters: [{ token: "hero", asset_id: hero.id }],
    props: await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const image = await snapshots.storeGeneratedMedia(
          projectId,
          Buffer.concat([png, Buffer.from(`overflow-${index}`)]),
          "png"
        );
        return { token: `prop-${index}`, asset_id: image.id };
      })
    )
  });

  it.each(["<Picture 9>", "Image 9"])(
    "blocks unsafe raw %s with nine references plus continuity before uploads or submission",
    async (numberedReference) => {
      await seed({ mode: "last_frame", opening_frame: "cut" });
      const snapshot = (await snapshots.get(projectId))!;
      const successor = rows(snapshot.state!.shots)[1]!;
      successor.references = await nineReferences();
      successor.video_prompt = `${numberedReference} is the parcel to carry.`;
      await snapshots.put({ projectId, state: snapshot.state! });
      const extract = vi.spyOn(media, "extractLastFrame");
      const grid = vi.spyOn(media, "createReferenceGrid");
      const input = request();
      const preview = await director.generateShots({
        ...input,
        isDryRun: true
      });
      expect(preview).toMatchObject({
        would_run_timeline_ids: [],
        blocked: [
          { timeline_id: "shot-2", reason_code: "raw_reference_overflow" }
        ]
      });
      const generated = await director.generateShots(input);
      expect(generated).toMatchObject({
        plan_id: null,
        would_run_timeline_ids: [],
        blocked: [
          { timeline_id: "shot-2", reason_code: "raw_reference_overflow" }
        ]
      });
      expect(extract).not.toHaveBeenCalled();
      expect(grid).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(uploadIds).toEqual([]);
      expect(submissions).toEqual([]);
      expect(rows((await cutShots())[1]!.versions)).toEqual([]);
    }
  );

  it("rejects raw numbered overflow when an unsubmitted legacy plan resumes, before preparation or upload", async () => {
    await seed({ mode: "last_frame", opening_frame: "cut" });
    await rm(source.path);
    const generated = await director.generateShots(request());
    const planId = String(generated.plan_id);
    const paused = await waitPlan(planId, "PAUSED");
    expect(step(paused, "use_provided_reference_frame").status).toBe("FAILED");
    expect(
      await jobs.get(String(step(paused, "submit_video_render").id))
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Model a pre-guard plan already on disk; resume does not call the planner.
    const target = rows(paused.local_targets)[0]!;
    target.references = await nineReferences();
    target.video_prompt = "<Picture 9> is the parcel to carry.";
    target._local_prompt_rewrite = "raw";
    await snapshots.putPlan(projectId, planId, paused);
    await writeFile(source.path, video);
    const extract = vi.spyOn(media, "extractLastFrame");
    const grid = vi.spyOn(media, "createReferenceGrid");
    director = makeDirector();
    await director.resumePlan(planId);
    const resumed = await waitPlan(planId, "PAUSED");
    expect(resumed).toMatchObject({
      error: {
        message: expect.stringContaining(
          "Raw prompts with numbered references cannot be gridded safely"
        )
      }
    });
    expect(
      await jobs.get(String(step(resumed, "submit_video_render").id))
    ).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    expect(grid).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadIds).toEqual([]);
    expect(submissions).toEqual([]);
    expect(rows((await cutShots())[1]!.versions)).toEqual([]);
  });
});
