import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared/contracts";
import { LocalScriptProjectService } from "../scriptProjects/localScriptProjectService";

import { registerScriptProjectHandlers } from "./registerScriptProjectHandlers";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), trusted: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("./trustedSender", () => ({ requireTrustedSender: mocks.trusted }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = (channel = IPC_CHANNELS.scriptProjectsGet as string) => {
  const snapshots = {
    get: vi.fn(async () => null),
    put: vi.fn(),
    getPlan: vi.fn(),
    cacheScheduledMedia: vi.fn()
  };
  const projects = { get: vi.fn() };
  const service = new LocalScriptProjectService(
    projects as never,
    snapshots as never,
    async () => "unused"
  );
  const manager = {
    isOpen: vi.fn(() => true),
    open: vi.fn(async (_root: string) => {})
  };
  const settings = { getLibraryRoot: vi.fn(async () => "old library") };
  registerScriptProjectHandlers({
    service,
    chat: {} as never,
    databaseManager: manager as never,
    settings: settings as never
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === channel
  )![1];
  return { service, manager, settings, handler, snapshots, projects };
};
beforeEach(() => vi.resetAllMocks());
const requests = [
  [IPC_CHANNELS.scriptProjectsGet, "project"],
  [IPC_CHANNELS.scriptProjectsGetPlan, "plan"],
  [IPC_CHANNELS.scriptProjectsCancelPlan, "plan"],
  [IPC_CHANNELS.scriptProjectsResumePlan, "plan"],
  [IPC_CHANNELS.scriptProjectsCast, { projectId: "project", script: "hello" }],
  [IPC_CHANNELS.scriptProjectsFindMedia, { assetId: "image" }],
  [IPC_CHANNELS.scriptProjectsGenerateSheets, { projectId: "project" }],
  [IPC_CHANNELS.scriptProjectsGenerateShots, { projectId: "project" }],
  [IPC_CHANNELS.scriptProjectsExportCut, { projectId: "project" }],
  [IPC_CHANNELS.scriptProjectsPut, { projectId: "project", state: {} }],
  [IPC_CHANNELS.scriptProjectsCacheMedia, "project"],
  [
    IPC_CHANNELS.scriptProjectsUpdate,
    {
      projectId: "project",
      operation: "describe-sheet",
      payload: { token: "hero" }
    }
  ],
  [IPC_CHANNELS.scriptProjectsGetRenderMetrics, "image"]
] as const;

describe("Director IPC library capture", () => {
  it.each(requests)(
    "refuses %s during teardown before database access",
    async (channel, input) => {
      const test = setup(channel);
      await test.service.suspendPlans();
      await expect(
        test.handler({}, input, "https://mock/image.png")
      ).rejects.toThrow();
      expect(test.manager.isOpen).not.toHaveBeenCalled();
      expect(test.snapshots.get).not.toHaveBeenCalled();
      expect(test.projects.get).not.toHaveBeenCalled();
    }
  );

  it.each(requests)(
    "does not retarget %s after library replacement during database setup",
    async (channel, input) => {
      const test = setup(channel);
      test.manager.isOpen.mockImplementationOnce(() => {
        test.service.stopPlans();
        test.service.resetPlans();
        return true;
      });
      await expect(
        test.handler({}, input, "https://mock/image.png")
      ).rejects.toThrow();
      expect(test.snapshots.get).not.toHaveBeenCalled();
      expect(test.snapshots.put).not.toHaveBeenCalled();
      expect(test.snapshots.getPlan).not.toHaveBeenCalled();
      expect(test.snapshots.cacheScheduledMedia).not.toHaveBeenCalled();
      expect(test.projects.get).not.toHaveBeenCalled();
    }
  );

  it("checks trust before opening a library scope", async () => {
    const test = setup();
    const capture = vi.spyOn(test.service, "inLibrary");
    mocks.trusted.mockImplementationOnce(() => {
      throw new Error("untrusted");
    });
    await expect(test.handler({}, "project")).rejects.toThrow("untrusted");
    expect(capture).not.toHaveBeenCalled();
    expect(test.manager.isOpen).not.toHaveBeenCalled();
  });

  it("will not open a stale library root resolved after teardown", async () => {
    const test = setup();
    const root = deferred<string>();
    test.manager.isOpen.mockReturnValue(false);
    test.settings.getLibraryRoot.mockReturnValueOnce(root.promise);
    const pending = test.handler({}, "project");
    const rejected = expect(pending).rejects.toThrow();
    await test.service.suspendPlans();
    test.service.resetPlans();
    root.resolve("old library");
    await rejected;
    expect(test.manager.open).not.toHaveBeenCalled();
    expect(test.snapshots.get).not.toHaveBeenCalled();
  });

  it("drains an already-issued database open before replacement", async () => {
    const test = setup();
    const opening = deferred<void>();
    test.manager.isOpen.mockReturnValue(false);
    test.manager.open.mockReturnValueOnce(opening.promise);
    const pending = test.handler({}, "project");
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(test.manager.open).toHaveBeenCalledTimes(1));
    let drained = false;
    const suspension = test.service.suspendPlans().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    opening.resolve();
    await suspension;
    await rejected;
    test.service.resetPlans();
    expect(test.snapshots.get).not.toHaveBeenCalled();
  });
});
