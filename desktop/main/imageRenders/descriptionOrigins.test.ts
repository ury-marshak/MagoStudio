import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { DatabaseManager } from "../database/databaseManager";
import {
  assets,
  clips,
  imageRenderJobs,
  projects,
  shots,
  tracks
} from "../database/schema";

import { ImageRenderService } from "./imageRenderService";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) }
}));
const managers: DatabaseManager[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

it.each(["kick", "reconcileInterruptedRenders"] as const)(
  "captures description origin before %s policy/DB waits",
  async (method) => {
    const root = await mkdtemp(path.join(tmpdir(), "mago-description-origin-"));
    directories.push(root);
    const manager = new DatabaseManager();
    managers.push(manager);
    await manager.open(root);
    const sourcePath = path.join(root, "fixture.png");
    await writeFile(sourcePath, "fixture bytes");
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
    await db.insert(assets).values({
      id: "asset",
      name: "Fixture",
      type: "image",
      sourcePath,
      status: "available"
    });
    await db.insert(clips).values({
      id: "clip",
      trackId: "track",
      assetId: "asset",
      name: "Fixture"
    });
    await db.insert(imageRenderJobs).values({
      id: "job",
      projectId: "project",
      shotId: "shot",
      trackId: "track",
      clipId: "clip",
      assetId: "asset",
      model: "qwen",
      status: "INQUEUE",
      providerRequestId: "accepted",
      requestJson: JSON.stringify({
        frame: 0,
        settings: {},
        referenceImageIds: []
      })
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = new AbortController();
    let current = old;
    const capture = vi.fn(() => current.signal);
    const service = new ImageRenderService(
      manager,
      async () => root,
      vi.fn(),
      vi.fn(),
      () => gate,
      capture
    );
    // Native generation/ingestion remain fixture boundaries here; this regression
    // proves propagation to those boundaries, not legacy write/transfer teardown.
    const internal = service as unknown as {
      processComfyQwen: (job: unknown, origin?: AbortSignal) => Promise<void>;
      completeImageBytes: (
        job: unknown,
        bytes: Buffer,
        provider: string,
        origin?: AbortSignal
      ) => Promise<void>;
    };
    const process = vi.spyOn(internal, "processComfyQwen").mockResolvedValue();
    const complete = vi
      .spyOn(internal, "completeImageBytes")
      .mockResolvedValue();
    const result = service[method]();
    expect(capture).toHaveBeenCalledTimes(1);
    old.abort();
    current = new AbortController();
    release();
    await result;
    if (method === "kick")
      expect(process).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "job" }),
        old.signal
      );
    else
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "job" }),
        expect.any(Buffer),
        "Recovered render",
        old.signal
      );
  }
);
