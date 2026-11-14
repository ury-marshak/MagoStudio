import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3
} from "../../shared/falSheetModel";
import { FAL_SHOT_PROVIDER } from "../../shared/falShotModel";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { assets, projectAssets, projects } from "../database/schema";
import { ScriptProjectSnapshotRepository } from "../database/scriptProjectSnapshotRepository";
import { LocalScriptProjectService } from "../scriptProjects/localScriptProjectService";

import { ExternalRenderAssets } from "./externalRenderAssets";
import { ExternalRenderJobRepository } from "./externalRenderJobRepository";
import { ExternalRenderJobService } from "./externalRenderJobService";
import { FalRenderProvider } from "./falRenderProvider";
import type { MediaRenderProvider } from "./mediaRenderProvider";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 960, height: 640 })
    })
  }
}));

vi.mock("../media/imageThumbnail", () => ({
  createImageThumbnail: async (_source: string, destination: string) => {
    await writeFile(destination, "thumbnail");
  }
}));

const endpoint = "fal-ai/nano-banana-2/edit";
const requestId = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
const url = `https://queue.fal.run/fal-ai/nano-banana-2/requests/${requestId}`;
const input = {
  id: "local-job",
  projectId: "project",
  provider: "fal",
  endpoint,
  kind: "image" as const,
  requestJson: { prompt: "A courier", resolution: "1K" },
  inputAssetIds: ["master-design"]
};

const queued = () =>
  Response.json({
    request_id: requestId,
    status: "IN_QUEUE",
    status_url: "https://untrusted.example/status"
  });

let manager: DatabaseManager;
let directory: string;
let transfer: ExternalRenderAssets;
let jobs: ExternalRenderJobRepository;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let service: ExternalRenderJobService;
let readKey: ReturnType<typeof vi.fn<(account: string) => Promise<string>>>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mago-fal-jobs-"));
  manager = new DatabaseManager();
  await manager.open(directory);
  await manager
    .get()
    .insert(projects)
    .values({ id: "project", name: "Project" });
  jobs = new ExternalRenderJobRepository(manager);
  transfer = new ExternalRenderAssets(manager, async () => directory);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  readKey = vi.fn(async () => "mock-key");
  service = new ExternalRenderJobService(
    jobs,
    new Map([
      [
        "fal",
        new FalRenderProvider(
          async () => ({ keychainAccount: "fal-original" }),
          readKey
        )
      ]
    ]),
    transfer
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  manager.close();
  await rm(directory, { recursive: true, force: true });
});

describe("persistent fal queue jobs", () => {
  it("snapshots the endpoint before submission and fetches the original job after reopening the library", async () => {
    fetchMock.mockImplementationOnce(async () => {
      expect(await jobs.get(input.id)).toMatchObject({
        status: "SUBMITTING",
        endpoint,
        requestId: null,
        requestJson: input.requestJson,
        inputAssetIds: input.inputAssetIds
      });
      return queued();
    });
    const submitted = await service.submit(input);
    expect(submitted).toMatchObject({ status: "SUBMITTED", requestId });
    expect(JSON.stringify(submitted)).not.toContain("mock-key");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://queue.fal.run/${endpoint}`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Key mock-key",
          "x-app-fal-disable-fallback": "true"
        }),
        redirect: "error",
        body: JSON.stringify(input.requestJson)
      })
    );

    manager.close();
    await manager.open(directory);
    const reopened = new ExternalRenderJobRepository(manager);
    const currentConfig = vi.fn(async () => ({ keychainAccount: "fal-new" }));
    service = new ExternalRenderJobService(
      reopened,
      new Map([["fal", new FalRenderProvider(currentConfig, readKey)]]),
      transfer
    );
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          { status: "IN_PROGRESS", request_id: requestId },
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({ status: "COMPLETED", request_id: requestId })
      )
      .mockResolvedValueOnce(
        Response.json({ images: [{ url: "https://v3.fal.media/output.png" }] })
      );

    expect(await reopened.listRecoverable()).toMatchObject([{ requestId }]);
    await expect(service.refresh(input.id)).resolves.toMatchObject({
      status: "SUBMITTED"
    });
    await expect(service.refresh(input.id)).resolves.toMatchObject({
      status: "OUTPUT_READY",
      endpoint,
      outputJson: { urls: ["https://v3.fal.media/output.png"] }
    });
    expect(currentConfig).not.toHaveBeenCalled();
    expect(readKey.mock.calls).toEqual([
      ["fal-original"],
      ["fal-original"],
      ["fal-original"]
    ]);
    expect(
      fetchMock.mock.calls.map(([target, options]) => [target, options?.method])
    ).toEqual([
      [`https://queue.fal.run/${endpoint}`, "POST"],
      [`${url}/status`, "GET"],
      [`${url}/status`, "GET"],
      [url, "GET"]
    ]);
  });

  it("stores video metadata and resumes after a polling connection failure", async () => {
    const videoEndpoint = "minimax/h3-max/reference-to-video";
    fetchMock
      .mockResolvedValueOnce(queued())
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(
        Response.json({ status: "COMPLETED", request_id: requestId })
      )
      .mockResolvedValueOnce(
        Response.json({
          video: { url: "https://v3.fal.media/output.mp4" },
          seed: 123,
          reference_tokens: 1024
        })
      );
    await service.submit({ ...input, kind: "video", endpoint: videoEndpoint });
    await expect(service.refresh(input.id)).rejects.toThrow(
      "Could not reach fal queue"
    );
    expect(await jobs.listRecoverable()).toMatchObject([
      { status: "SUBMITTED", requestId }
    ]);
    await expect(service.refresh(input.id)).resolves.toMatchObject({
      status: "OUTPUT_READY",
      endpoint: videoEndpoint,
      outputJson: {
        urls: ["https://v3.fal.media/output.mp4"],
        seed: 123,
        referenceTokens: 1024
      }
    });
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")
    ).toHaveLength(1);
  });

  it("records an uncertain submission and prevents a second POST for the same job", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection lost"));
    await expect(service.submit(input)).rejects.toThrow(
      "fal may have accepted this job"
    );
    expect(await jobs.get(input.id)).toMatchObject({
      status: "SUBMISSION_UNKNOWN",
      requestId: null
    });
    await expect(service.submit(input)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await jobs.listRecoverable()).toEqual([]);
  });

  it("separates an explicit rejection from an uncertain submission", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("provider diagnostic", { status: 429 })
    );
    await expect(service.submit(input)).rejects.toThrow("HTTP 429");
    expect(await jobs.get(input.id)).toMatchObject({
      status: "FAILED",
      error: "fal queue returned HTTP 429"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks a submission interrupted before its request ID was saved", async () => {
    await jobs.beginSubmission({ ...input, keychainAccount: "fal-original" });
    manager.close();
    await manager.open(directory);
    await jobs.markInterruptedSubmissions();
    expect(await jobs.get(input.id)).toMatchObject({
      status: "SUBMISSION_UNKNOWN"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the result before treating a completed job as a success", async () => {
    fetchMock
      .mockResolvedValueOnce(queued())
      .mockResolvedValueOnce(
        Response.json({ status: "COMPLETED", request_id: requestId })
      )
      .mockResolvedValueOnce(new Response("cancelled", { status: 499 }));
    await service.submit(input);
    await expect(service.refresh(input.id)).resolves.toMatchObject({
      status: "CANCELLED",
      outputJson: null
    });
  });

  it.each([
    { response: "OK", code: 200, status: "CANCELLED" },
    {
      response: "CANCELLATION_REQUESTED",
      code: 202,
      status: "CANCELLATION_REQUESTED"
    }
  ])(
    "handles the $response cancellation acknowledgement",
    async ({ response, code, status }) => {
      fetchMock
        .mockResolvedValueOnce(queued())
        .mockResolvedValueOnce(
          Response.json({ status: response }, { status: code })
        );
      await service.submit(input);
      await expect(service.cancel(input.id)).resolves.toMatchObject({ status });
      expect(fetchMock).toHaveBeenLastCalledWith(
        `${url}/cancel`,
        expect.objectContaining({ method: "PUT" })
      );
    }
  );
});

it("dispatches a different provider through the same persistence path", async () => {
  const submit = vi.fn(async () => "42");
  const alternate = {
    prepareSubmission: vi.fn(async () => ({
      keychainAccount: "alternate-key",
      submit
    })),
    refresh: vi.fn<MediaRenderProvider["refresh"]>().mockResolvedValue({
      status: "OUTPUT_READY",
      outputJson: { urls: ["https://example.com/output.png"] }
    }),
    cancel: vi.fn<MediaRenderProvider["cancel"]>()
  } satisfies MediaRenderProvider;
  const falConfig = vi.fn(async () => ({ keychainAccount: "fal-original" }));
  const fal = new FalRenderProvider(falConfig, readKey);
  const alternateInput = {
    ...input,
    provider: "alternate",
    endpoint: "example/image",
    requestJson: { prompt: "A courier", aspectRatio: "1:1" }
  };
  service = new ExternalRenderJobService(
    jobs,
    new Map<string, MediaRenderProvider>([
      ["fal", fal],
      ["alternate", alternate]
    ]),
    transfer
  );
  await expect(service.submit(alternateInput)).resolves.toMatchObject({
    provider: "alternate",
    endpoint: alternateInput.endpoint,
    requestId: "42"
  });
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    alternateInput.requestJson,
    undefined
  );

  const falOnly = new ExternalRenderJobService(
    jobs,
    new Map([["fal", fal]]),
    transfer
  );
  await expect(falOnly.refresh(input.id)).rejects.toThrow(
    "Render provider is unavailable: alternate"
  );
  await expect(jobs.get(input.id)).resolves.toMatchObject({
    status: "SUBMITTED"
  });
  await expect(service.refresh(input.id)).resolves.toMatchObject({
    status: "OUTPUT_READY"
  });
  expect(alternate.refresh).toHaveBeenCalledExactlyOnceWith(
    {
      endpoint: alternateInput.endpoint,
      requestId: "42",
      keychainAccount: "alternate-key"
    },
    "image",
    undefined
  );
  expect(falConfig).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("external render asset transfer", () => {
  const outputUrl = "https://v3.fal.media/output.png";
  const completed = () =>
    Response.json({ status: "COMPLETED", request_id: requestId });
  const result = (urls: string[]) =>
    Response.json({ images: urls.map((url) => ({ url })) });

  it("uploads project assets in reference order before submitting the saved payload", async () => {
    const ids = ["master-design", "wardrobe"];
    for (const id of ids) {
      const sourcePath = path.join(directory, `${id}.png`);
      await writeFile(sourcePath, id);
      await manager
        .get()
        .insert(assets)
        .values({ id, name: id, type: "image", sourcePath });
      await manager
        .get()
        .insert(projectAssets)
        .values({ projectId: input.projectId, assetId: id });
      fetchMock.mockResolvedValueOnce(
        Response.json({
          file_url: `https://v3.fal.media/${id}.png`,
          upload_url: `https://v3.fal.media/upload/${id}`
        })
      );
      fetchMock.mockImplementationOnce(async (url, options) => {
        expect(url).toBe(`https://v3.fal.media/upload/${id}`);
        expect(options?.method).toBe("PUT");
        expect(options?.headers).toEqual({ "Content-Type": "image/png" });
        const body = options?.body;
        if (!(body instanceof Blob)) throw new Error("Missing upload body");
        expect(await body.text()).toBe(id);
        expect(await jobs.get(input.id)).toBeNull();
        return new Response(null, { status: 200 });
      });
    }
    fetchMock.mockResolvedValueOnce(queued());

    const requestJson = {
      ...input.requestJson,
      image_urls: ids.map((id) => `https://v3.fal.media/${id}.png`)
    };
    await expect(
      service.submit({
        ...input,
        inputAssetIds: ids,
        assetUrlField: "image_urls"
      })
    ).resolves.toMatchObject({ requestJson, inputAssetIds: ids });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Key mock-key" }),
        body: JSON.stringify({
          file_name: "master-design.png",
          content_type: "image/png"
        })
      })
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://queue.fal.run/${endpoint}`,
      expect.objectContaining({ body: JSON.stringify(requestJson) })
    );
  });

  it("keeps upload failures outside the generation submission state", async () => {
    await expect(
      service.submit({ ...input, assetUrlField: "image_urls" })
    ).rejects.toThrow("unavailable in this project");
    expect(await jobs.get(input.id)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries an interrupted download after reopening and ingests the output once", async () => {
    fetchMock
      .mockResolvedValueOnce(queued())
      .mockResolvedValueOnce(completed())
      .mockResolvedValueOnce(result([outputUrl]))
      .mockResolvedValueOnce(
        new Response("short", { headers: { "content-length": "100" } })
      );

    await service.submit(input);
    await service.refresh(input.id);
    await expect(service.ingest(input.id)).rejects.toThrow("incomplete");
    expect(await jobs.listRecoverable()).toMatchObject([
      { requestId, status: "OUTPUT_READY" }
    ]);
    expect(await manager.get().select().from(assets)).toEqual([]);
    const renderRoot = path.join(directory, "renders", "external");
    const [folder] = await readdir(renderRoot);
    expect(await readdir(path.join(renderRoot, folder!))).toEqual([]);

    manager.close();
    await manager.open(directory);
    fetchMock.mockResolvedValueOnce(new Response("complete image"));
    const [first, second] = await Promise.all([
      service.ingest(input.id),
      service.ingest(input.id)
    ]);
    expect(first).toEqual(second);
    expect(first.status).toBe("INGESTED");
    const [asset] = await manager.get().select().from(assets);
    expect(first.outputJson?.assetIds).toEqual([asset?.id]);
    expect(asset).toMatchObject({
      type: "image",
      origin: "generated",
      width: 960,
      height: 640
    });
    expect(await readFile(asset!.sourcePath, "utf8")).toBe("complete image");
    expect(await manager.get().select().from(projectAssets)).toMatchObject([
      { projectId: input.projectId, assetId: asset!.id }
    ]);
    expect(await jobs.listRecoverable()).toEqual([]);
    await expect(service.ingest(input.id)).resolves.toEqual(first);
    expect(
      fetchMock.mock.calls.filter(([target]) => target === outputUrl)
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")
    ).toHaveLength(1);
  });

  it("stores an MP4 and measures its video and audio metadata", async () => {
    const source = path.join(directory, "fixture.mp4");
    execFileSync(ffmpegPath!, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x48:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "1",
      "-pix_fmt",
      "yuv420p",
      source
    ]);
    const bytes = await readFile(source);
    fetchMock
      .mockResolvedValueOnce(queued())
      .mockResolvedValueOnce(completed())
      .mockResolvedValueOnce(
        Response.json({
          video: { url: "https://v3.fal.media/output.mp4" },
          seed: 42
        })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));

    await service.submit({
      ...input,
      kind: "video",
      endpoint: "minimax/h3-max/reference-to-video"
    });
    await service.refresh(input.id);
    const job = await service.ingest(input.id);

    const [asset] = await manager.get().select().from(assets);
    expect(job.outputJson).toMatchObject({ seed: 42, assetIds: [asset?.id] });
    expect(asset).toMatchObject({
      type: "video",
      width: 64,
      height: 48,
      fps: 24000,
      duration: 1000,
      frameCount: 24
    });
    expect(JSON.parse(asset!.dataJson)).toMatchObject({ hasAudio: true });
    expect(await readFile(asset!.sourcePath)).toEqual(bytes);
  });

  it("looks up an expired URL using the existing request ID", async () => {
    const renewed = "https://v3.fal.media/renewed.png";
    fetchMock
      .mockResolvedValueOnce(queued())
      .mockResolvedValueOnce(completed())
      .mockResolvedValueOnce(result([outputUrl]))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(completed())
      .mockResolvedValueOnce(result([renewed]))
      .mockResolvedValueOnce(new Response("image"));
    await service.submit(input);
    await service.refresh(input.id);
    await expect(service.ingest(input.id)).resolves.toMatchObject({
      status: "INGESTED",
      requestId,
      outputJson: { urls: [renewed], assetIds: [expect.any(String)] }
    });
    expect(fetchMock.mock.calls.slice(3).map(([target]) => target)).toEqual([
      outputUrl,
      `${url}/status`,
      url,
      renewed
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(renewed, {
      redirect: "error",
      signal: expect.any(AbortSignal)
    });
  });
});

it.each([
  {
    model: FAL_SHEET_MODEL_21,
    base: "google/nano-banana-2.1",
    generate: "google/nano-banana-2.1",
    sizing: {
      aspect_ratio: "3:2",
      resolution: "1K",
      thinking_level: "minimal"
    },
    editSizing: {
      aspect_ratio: "3:2",
      resolution: "1K",
      thinking_level: "minimal"
    },
    recordedSize: { resolution: "1K" }
  },
  {
    model: FAL_SHEET_MODEL_H3,
    base: "minimax/h3-image",
    generate: "minimax/h3-image/text-to-image",
    sizing: {
      image_size: { width: 1248, height: 832 },
      enable_prompt_expansion: false
    },
    editSizing: { image_size: { width: 1248, height: 832 } },
    recordedSize: { image_size: { width: 1248, height: 832 } }
  }
])(
  "resumes a Director sheet and edits it with $model",
  async ({ model, base, generate, sizing, editSizing, recordedSize }) => {
    const projectRepository = new ProjectRepository(
      manager,
      async () => directory
    );
    const project = await projectRepository.create({
      name: "Director",
      description: "",
      settings: { type: "script_to_shots" }
    });
    const projectId = project.id;
    const snapshots = new ScriptProjectSnapshotRepository(
      manager,
      async () => directory
    );
    const getComfyEndpoint = vi.fn(async () => {
      throw new Error("ComfyUI must not be used");
    });
    const createDirector = () =>
      new LocalScriptProjectService(
        projectRepository,
        snapshots,
        getComfyEndpoint,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new ExternalRenderJobService(
          new ExternalRenderJobRepository(manager),
          new Map([
            [
              "fal",
              new FalRenderProvider(
                async () => ({ keychainAccount: "fal-original" }),
                readKey
              )
            ]
          ]),
          new ExternalRenderAssets(
            manager,
            async () => directory,
            (id, projectId) => snapshots.resolveMediaPath(id, projectId)
          )
        )
      );
    let director = createDirector();
    await snapshots.put({
      projectId,
      state: {
        keys: [
          {
            token: "courier",
            name: "Courier",
            kind: "character",
            prompt: "A courier",
            images: []
          }
        ],
        shots: []
      }
    });
    const request = {
      projectId,
      isDryRun: false,
      outputSize: [1024, 1536] as [number, number],
      settings: { render_model: model },
      tokens: ["courier"]
    };
    fetchMock
      .mockResolvedValueOnce(queued())
      .mockRejectedValueOnce(new Error("temporary outage"));
    const generated = await director.generateSheets(request);
    const planId = String(generated.plan_id);
    await vi.waitFor(async () => {
      expect(await director.getPlan(planId)).toMatchObject({
        status: "PAUSED"
      });
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://queue.fal.run/${generate}`,
      expect.objectContaining({ method: "POST", body: expect.any(String) })
    );
    const generateBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof generateBody !== "string")
      throw new Error("Missing generation JSON");
    expect(JSON.parse(generateBody)).toMatchObject({
      ...sizing,
      output_format: "png",
      prompt: expect.stringContaining("A courier")
    });

    const completed = (id: string) =>
      Response.json({ status: "COMPLETED", request_id: id });
    const result = (file: string) =>
      Response.json({ images: [{ url: `https://v3.fal.media/${file}.png` }] });
    manager.close();
    await manager.open(directory);
    director = createDirector();
    fetchMock
      .mockResolvedValueOnce(completed(requestId))
      .mockResolvedValueOnce(result("courier"))
      .mockResolvedValueOnce(new Response("original image"));
    await director.resumePlan(planId);
    await vi.waitFor(async () => {
      expect(await director.getPlan(planId)).toMatchObject({
        status: "COMPLETED"
      });
    });
    const current = (await snapshots.get(projectId))?.state?.keys as Array<{
      effective_asset_id: string;
      images: Array<{ asset_id: string }>;
    }>;
    const sourceId = current[0]!.effective_asset_id;
    expect(current[0]!.images).toMatchObject([
      {
        asset_id: sourceId,
        url: `mago-media://script-project/${sourceId}`,
        render_settings: {
          provider: "fal",
          endpoint: generate,
          render_model: model,
          ...recordedSize,
          width: 960,
          height: 640
        }
      }
    ]);
    expect(
      await snapshots.resolveMediaPath(sourceId, "other-project")
    ).toBeNull();

    const additional = await snapshots.storeGeneratedMedia(
      projectId,
      Buffer.from("wardrobe"),
      "png"
    );
    for (const [name, content] of [
      ["courier", "original image"],
      ["wardrobe", "wardrobe"]
    ]) {
      fetchMock
        .mockResolvedValueOnce(
          Response.json({
            file_url: `https://v3.fal.media/input/${name}.png`,
            upload_url: `https://v3.fal.media/upload/${name}`
          })
        )
        .mockImplementationOnce(async (_url, options) => {
          const body = options?.body;
          if (!(body instanceof Blob)) throw new Error("Missing upload body");
          expect(await body.text()).toBe(content);
          return new Response(null);
        });
    }
    const editId = "edit-request";
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ status: "IN_QUEUE", request_id: editId })
      )
      .mockResolvedValueOnce(completed(editId))
      .mockResolvedValueOnce(result("edited"))
      .mockResolvedValueOnce(new Response("edited image"));
    const edited = await director.generateSheets({
      ...request,
      tokens: ["courier--winter"],
      sheetGroupToCreate: { name: "Winter courier", kind: "character" },
      referenceAssetIds: [additional.id],
      settings: { ...request.settings, prompt: "Add a winter coat" }
    });
    await vi.waitFor(async () => {
      expect(await director.getPlan(String(edited.plan_id))).toMatchObject({
        status: "COMPLETED"
      });
    });
    const submissions = fetchMock.mock.calls.filter(
      ([target, options]) =>
        typeof target === "string" &&
        target.startsWith("https://queue.fal.run/") &&
        options?.method === "POST"
    );
    expect(submissions.map(([target]) => target)).toEqual([
      `https://queue.fal.run/${generate}`,
      `https://queue.fal.run/${base}/edit`
    ]);
    const editBody = submissions[1]?.[1]?.body;
    if (typeof editBody !== "string") throw new Error("Missing edit JSON");
    expect(JSON.parse(editBody)).toMatchObject({
      ...editSizing,
      image_urls: [
        "https://v3.fal.media/input/courier.png",
        "https://v3.fal.media/input/wardrobe.png"
      ],
      prompt: expect.stringContaining(
        "Preserve the exact same character identity"
      )
    });
    if (model === FAL_SHEET_MODEL_H3)
      expect(JSON.parse(editBody)).not.toHaveProperty(
        "enable_prompt_expansion"
      );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://queue.fal.run/${base}/requests/${editId}/status`,
      expect.objectContaining({ method: "GET" })
    );
    expect(getComfyEndpoint).not.toHaveBeenCalled();
  }
);

it("recovers an accepted H3 Max shot automatically and leaves later shots unsubmitted", async () => {
  const projectRepository = new ProjectRepository(
    manager,
    async () => directory
  );
  const { id: projectId } = await projectRepository.create({
    name: "H3 Director",
    description: "",
    settings: { type: "script_to_shots" }
  });
  const snapshots = new ScriptProjectSnapshotRepository(
    manager,
    async () => directory
  );
  const getComfyEndpoint = vi.fn(async () => {
    throw new Error("ComfyUI must not be used");
  });
  const makeDirector = () =>
    new LocalScriptProjectService(
      projectRepository,
      snapshots,
      getComfyEndpoint,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ExternalRenderJobService(
        new ExternalRenderJobRepository(manager),
        new Map([
          [
            "fal",
            new FalRenderProvider(
              async () => ({ keychainAccount: "fal-original" }),
              readKey
            )
          ]
        ]),
        new ExternalRenderAssets(
          manager,
          async () => directory,
          (id, projectId) => snapshots.resolveMediaPath(id, projectId)
        )
      )
    );
  const reference = await snapshots.storeGeneratedMedia(
    projectId,
    Buffer.from("courier"),
    "png"
  );
  await snapshots.put({
    projectId,
    state: {
      keys: [],
      shots: [1, 2].map((index) => ({
        timeline_id: `shot-${index}`,
        shot_index: index - 1,
        sequence_id: index,
        key: String(index),
        video_prompt: "<Picture 1> walks in.",
        duration_s: 5,
        references: {
          characters: [{ token: "courier", asset_id: reference.id }]
        },
        missing_references: []
      }))
    },
    cut: {
      project_id: projectId,
      shots: [1, 2].map((index) => ({
        timeline_id: `shot-${index}`,
        sequence_id: index,
        versions: []
      }))
    }
  });
  const request = {
    projectId,
    isDryRun: false,
    videoSettings: { render_provider: FAL_SHOT_PROVIDER, prompt_rewrite: "raw" }
  };
  const shotQueue = "https://queue.fal.run/minimax/h3-max/reference-to-video";
  const followUp = `https://queue.fal.run/minimax/h3-max/requests/${requestId}`;
  const cdn = "https://v3.fal.media/director.mp4";
  const uploaded = "https://v3.fal.media/courier.png";
  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        file_url: uploaded,
        upload_url: "https://v3.fal.media/upload/shot"
      })
    )
    .mockResolvedValueOnce(new Response(null))
    .mockResolvedValueOnce(queued())
    .mockRejectedValueOnce(new Error("offline"));
  let director = makeDirector();
  const generated = await director.generateShots(request);
  const planId = String(generated.plan_id);
  await vi.waitFor(async () => {
    expect(await director.getPlan(planId)).toMatchObject({ status: "PAUSED" });
  });
  const call = fetchMock.mock.calls.find(([target]) => target === shotQueue);
  const body = call?.[1]?.body;
  if (typeof body !== "string") throw new Error("Missing shot JSON");
  expect(JSON.parse(body)).toMatchObject({
    prompt: "Image 1 walks in.",
    reference_image_urls: [uploaded],
    duration: 5,
    resolution: "768P",
    aspect_ratio: "16:9",
    prompt_expansion_mode: "disabled"
  });

  const source = path.join(directory, "shot.mp4");
  execFileSync(ffmpegPath!, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x48:rate=24",
    "-t",
    "1",
    "-pix_fmt",
    "yuv420p",
    source
  ]);
  const bytes = await readFile(source);
  fetchMock
    .mockResolvedValueOnce(
      Response.json({ status: "COMPLETED", request_id: requestId })
    )
    .mockResolvedValueOnce(
      Response.json({ video: { url: cdn }, seed: 42, reference_tokens: 12 })
    )
    .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
  manager.close();
  await manager.open(directory);
  director = makeDirector();
  await director.recoverExternalRenderPlans();
  await vi.waitFor(async () => {
    const plan = await director.getPlan(planId);
    expect(plan).toMatchObject({
      status: "PAUSED",
      steps: expect.arrayContaining([
        expect.objectContaining({
          timeline_id: "shot-1",
          tool_name: "poll_video_render",
          status: "COMPLETED"
        }),
        expect.objectContaining({
          timeline_id: "shot-2",
          tool_name: "submit_video_render",
          status: "PENDING"
        })
      ])
    });
  });
  expect(fetchMock.mock.calls.slice(4).map(([target]) => target)).toEqual([
    `${followUp}/status`,
    followUp,
    cdn
  ]);
  expect((await snapshots.get(projectId))?.cut?.shots).toMatchObject([
    {
      timeline_id: "shot-1",
      versions: [
        {
          ready: true,
          size: [64, 48],
          input_settings: {
            provider: "fal",
            endpoint: "minimax/h3-max/reference-to-video",
            duration_s: 5,
            measured_duration_s: 1,
            seed: 42,
            reference_tokens: 12
          }
        }
      ]
    },
    { timeline_id: "shot-2", versions: [] }
  ]);
  expect(getComfyEndpoint).not.toHaveBeenCalled();

  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        file_url: uploaded,
        upload_url: "https://v3.fal.media/upload/shot"
      })
    )
    .mockResolvedValueOnce(new Response(null))
    .mockRejectedValueOnce(new Error("queue response lost"));
  await director.resumePlan(planId);
  await vi.waitFor(async () => {
    expect(await director.getPlan(planId)).toMatchObject({
      status: "PAUSED",
      error: { message: expect.stringContaining("may have accepted") }
    });
  });
  await expect(
    director.generateShots({ ...request, timelineIds: ["shot-2"] })
  ).rejects.toThrow("Review fal's request history");
  expect(
    fetchMock.mock.calls.filter(([target]) => target === shotQueue)
  ).toHaveLength(2);
});
