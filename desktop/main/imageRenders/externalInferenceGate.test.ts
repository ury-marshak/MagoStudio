import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  nativeImage: {}
}));

import type {
  LocalImageRenderInput,
  LocalVideoRenderInput
} from "../../shared/contracts";
import { closeAllComfyProgressMonitors } from "../comfy/comfyProgressMonitors";
import { DatabaseManager } from "../database/databaseManager";
import {
  assets,
  clips,
  imageRenderJobs,
  projects,
  shots,
  tracks
} from "../database/schema";
import { clearLibraryIssues, listLibraryIssues } from "../libraryHealth";
import { createExternalProviderSettings } from "../providers/externalProviderSettings";

import { ImageRenderService } from "./imageRenderService";

let root: string;
let manager: DatabaseManager;
const transport = vi.fn();
const socket = vi.fn();
const endpoint = vi.fn(async () => "http://localhost:8188");
const models = [
  "qwen",
  "wan_animate_2_2",
  "wan_vace_2_1",
  "mago_style_transfer_local",
  "mago_animate",
  "ltx_2_3_spatial_upscaler",
  "minimax_h3_local"
] as const;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mago-legacy-queue-audit-"));
  manager = new DatabaseManager();
  await manager.open(root);
  vi.clearAllMocks();
  clearLibraryIssues();
  transport.mockRejectedValue(new Error("Unexpected transport"));
  vi.stubGlobal("fetch", transport);
  vi.stubGlobal("WebSocket", socket);
  await writeFile(
    path.join(root, "external-providers.json"),
    JSON.stringify({ fal: { keychainAccount: "nonexistent-audit-account" } })
  );
});
afterEach(async () => {
  closeAllComfyProgressMonitors();
  manager.close();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
const service = () =>
  new ImageRenderService(
    manager,
    async () => root,
    endpoint,
    undefined,
    createExternalProviderSettings(() => root).assertLegacyInferenceAvailable
  );

it.each(models)(
  "blocks new %s inference before model probes, preparation or database writes",
  async (model) => {
    const render = service();
    if (model === "qwen")
      await expect(
        render.submit({ model } as LocalImageRenderInput)
      ).rejects.toThrow("unavailable while external providers");
    else
      await expect(
        render.submitVideo({ model } as LocalVideoRenderInput)
      ).rejects.toThrow("unavailable while external providers");
    expect(await manager.get().select().from(imageRenderJobs)).toEqual([]);
    expect(endpoint).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  "leaves historical queues unchanged with saved provider IDs = %s, including saved endpoints",
  async (accepted) => {
    const db = manager.get();
    await db.insert(projects).values({ id: "project", name: "Fixture" });
    await db
      .insert(shots)
      .values({ id: "shot", projectId: "project", name: "Fixture" });
    await db.insert(tracks).values({
      id: "track",
      projectId: "project",
      shotId: "shot",
      name: "Fixture",
      type: "image"
    });
    for (const model of models) {
      const id = model;
      await db.insert(assets).values({
        id,
        name: id,
        type: "image",
        sourcePath: path.join(root, "missing.png"),
        status: accepted ? "INQUEUE" : "PENDING"
      });
      await db
        .insert(clips)
        .values({ id, trackId: "track", assetId: id, name: id });
      await db.insert(imageRenderJobs).values({
        id,
        projectId: "project",
        shotId: "shot",
        trackId: "track",
        clipId: id,
        assetId: id,
        model,
        status: accepted ? "INQUEUE" : "PENDING",
        providerRequestId: accepted ? `saved-${id}` : null,
        requestJson: JSON.stringify({
          frame: 0,
          settings: {},
          referenceImageIds: [],
          comfyEndpoint: "http://localhost:8188"
        })
      });
    }
    const before = await db.select().from(imageRenderJobs);
    const beforeAssets = await db.select().from(assets);
    const render = service();
    await expect(render.reconcileInterruptedRenders()).resolves.toBeUndefined();
    await expect(render.kick()).resolves.toBeUndefined();
    for (const model of models)
      await expect(render.cancel(model)).rejects.toThrow(
        "unavailable while external providers"
      );
    // Ordinary queue inspection remains possible without opening a WebSocket.
    expect(await render.listQueue()).toHaveLength(models.length);
    expect(await db.select().from(imageRenderJobs)).toEqual(before);
    expect(await db.select().from(assets)).toEqual(beforeAssets);
    expect(endpoint).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  }
);

it("fails closed if provider metadata becomes unreadable", async () => {
  await writeFile(path.join(root, "external-providers.json"), "{corrupt");
  await expect(service().kick()).rejects.toThrow("invalid JSON");
  expect(transport).not.toHaveBeenCalled();
  expect(socket).not.toHaveBeenCalled();
});

it("keeps empty external-library recovery and polling free of inference and library-health errors", async () => {
  const render = service();
  await render.reconcileInterruptedRenders();
  await render.kick();
  expect(listLibraryIssues()).toEqual([]);
  expect(await manager.get().select().from(imageRenderJobs)).toEqual([]);
  expect(transport).not.toHaveBeenCalled();
  expect(socket).not.toHaveBeenCalled();
});
