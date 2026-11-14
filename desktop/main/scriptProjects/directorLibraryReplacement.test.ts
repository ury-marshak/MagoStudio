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
import { ExternalRenderJobRepository } from "../providers/externalRenderJobRepository";
import { ExternalRenderJobService } from "../providers/externalRenderJobService";
import type { MediaRenderProvider } from "../providers/mediaRenderProvider";
import type { VisionGenerator } from "../vlm/visionGenerator";

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
const setup = async () => {
  let root = await mkdtemp(path.join(tmpdir(), "mago-plan-library-"));
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
  const replace = async () => {
    manager.close();
    const next = await mkdtemp(path.join(tmpdir(), "mago-plan-replacement-"));
    roots.push(next);
    await copyFile(
      path.join(root, "mago.sqlite3"),
      path.join(next, "mago.sqlite3")
    );
    root = next;
    await manager.open(root);
  };
  return { manager, projects, snapshots, project, replace };
};

it("keeps late casting/repair and plan writes out of a replacement SQLite library with reused IDs", async () => {
  const test = await setup();
  let finish!: (value: { text: string; model: string }) => void;
  const generate = vi
    .fn<VisionGenerator>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockRejectedValue(new Error("replacement mock provider unavailable"));
  const service = new LocalScriptProjectService(
    test.projects,
    test.snapshots,
    async () => "unused",
    undefined,
    undefined,
    undefined,
    undefined,
    async () => generate
  );
  const input = {
    projectId: test.project.id,
    script: "INT. ROOM - DAY\nA person enters.",
    maxShots: 1,
    isAtomicShotsRequested: false
  };
  const old = await service.cast(input);
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  await service.suspendPlans();
  const saved = await test.snapshots.getPlan(old.plan_id);
  await test.replace();
  service.resetPlans();
  const write = vi.spyOn(test.snapshots, "put");
  const planWrite = vi.spyOn(test.snapshots, "putPlan");
  finish({ text: "{malformed", model: "old model" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(write).not.toHaveBeenCalled();
  expect(planWrite).not.toHaveBeenCalled();
  expect(await test.snapshots.getPlan(old.plan_id)).toEqual(saved);
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await service.getPlan(old.plan_id))?.status).toBe("PAUSED");
  const next = await service.cast(input);
  await vi.waitFor(async () =>
    expect((await test.snapshots.getPlan(next.plan_id))?.status).toBe("PAUSED")
  );
  expect(generate).toHaveBeenCalledTimes(2);
});

it("retains an uncertain submission across real library replacement and never posts it again", async () => {
  const test = await setup();
  const jobs = new ExternalRenderJobRepository(test.manager);
  let accept!: (requestId: string) => void;
  const submit = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        accept = resolve;
      })
  );
  const cancel = vi.fn();
  const provider = {
    prepareSubmission: async () => ({ keychainAccount: "mock", submit }),
    cancel
  };
  const service = new ExternalRenderJobService(
    jobs,
    new Map([["mock", provider as unknown as MediaRenderProvider]]),
    {} as never
  );
  const input = {
    id: "same-job",
    projectId: test.project.id,
    provider: "mock",
    endpoint: "model/video",
    kind: "video" as const,
    requestJson: { prompt: "frozen" },
    inputAssetIds: []
  };
  const pending = service.submit(input);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  await service.suspend();
  expect((await jobs.get(input.id))?.status).toBe("SUBMITTING");
  await test.replace();
  // The same fail-closed transition used during app startup, not a retry.
  await jobs.markInterruptedSubmissions();
  service.reset();
  accept("late-accepted-id");
  await rejected;
  expect(await jobs.get(input.id)).toMatchObject({
    status: "SUBMISSION_UNKNOWN",
    requestId: null,
    requestJson: input.requestJson
  });
  await expect(service.submit(input)).rejects.toThrow();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
});
