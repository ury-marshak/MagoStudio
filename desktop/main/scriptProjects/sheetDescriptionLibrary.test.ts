import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}));

import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { ScriptProjectSnapshotRepository } from "../database/scriptProjectSnapshotRepository";

import { LocalScriptProjectService } from "./localScriptProjectService";

const roots: string[] = [];
const managers: DatabaseManager[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("prevents a late sheet description writing to a real replacement library with identical project and image IDs", async () => {
  let root = await mkdtemp(path.join(tmpdir(), "mago-sheet-library-"));
  roots.push(root);
  const manager = new DatabaseManager();
  managers.push(manager);
  await manager.open(root);
  const projects = new ProjectRepository(manager, async () => root);
  const snapshots = new ScriptProjectSnapshotRepository(
    manager,
    async () => root
  );
  const project = await projects.create({
    name: "Script",
    description: "",
    settings: { type: "script_to_shots" }
  });
  const asset = await snapshots.storeGeneratedMedia(
    project.id,
    Buffer.from("fixture media"),
    "png"
  );
  await snapshots.put({
    projectId: project.id,
    state: {
      keys: [
        {
          token: "hero",
          kind: "character",
          name: "Hero",
          enabled: true,
          effective_asset_id: asset.id,
          effective_source: "render",
          description: "seed",
          seed_description: "seed",
          images: [
            {
              asset_id: asset.id,
              source: "render",
              description: null,
              has_description: false
            }
          ]
        }
      ],
      shots: []
    }
  });
  let finishOld!: (description: string) => void;
  const describe = vi
    .fn<
      (source: string, kind: string, signal?: AbortSignal) => Promise<string>
    >()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    )
    .mockResolvedValue("replacement hero");
  const service = new LocalScriptProjectService(
    projects,
    snapshots,
    async () => "unused",
    undefined,
    describe
  );
  const input = {
    projectId: project.id,
    operation: "describe-sheet" as const,
    payload: { token: "hero", assetId: asset.id }
  };
  const old = service.update(input);
  const rejected = expect(old).rejects.toThrow();
  await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(1));
  await service.suspendDescriptions();
  await rejected;
  manager.close();
  const replacement = await mkdtemp(
    path.join(tmpdir(), "mago-sheet-replacement-")
  );
  roots.push(replacement);
  await copyFile(
    path.join(root, "mago.sqlite3"),
    path.join(replacement, "mago.sqlite3")
  );
  // Copying the DB deliberately preserves IDs. Source paths are stubbed only for
  // the replacement's missing fixture bytes; all snapshot reads/writes are real.
  root = replacement;
  await manager.open(root);
  vi.spyOn(snapshots, "resolveMediaPath").mockResolvedValue("replacement.png");
  service.resetDescriptions();
  const write = vi.spyOn(snapshots, "put");
  finishOld("old hero");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(write).not.toHaveBeenCalled();
  expect((await snapshots.get(project.id))?.state).toMatchObject({
    keys: [expect.objectContaining({ description: "seed" })]
  });
  await service.update(input);
  expect(write).toHaveBeenCalledTimes(1);
  expect((await snapshots.get(project.id))?.state).toMatchObject({
    keys: [expect.objectContaining({ description: "replacement hero" })]
  });
});
