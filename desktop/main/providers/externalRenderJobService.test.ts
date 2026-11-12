import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseManager } from "../database/databaseManager";
import { projects } from "../database/schema";

import { ExternalRenderJobRepository } from "./externalRenderJobRepository";
import { ExternalRenderJobService } from "./externalRenderJobService";
import { FalRenderProvider } from "./falRenderProvider";
import type { MediaRenderProvider } from "./mediaRenderProvider";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() }
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
    ])
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
      new Map([["fal", new FalRenderProvider(currentConfig, readKey)]])
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
    ])
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

  const falOnly = new ExternalRenderJobService(jobs, new Map([["fal", fal]]));
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
