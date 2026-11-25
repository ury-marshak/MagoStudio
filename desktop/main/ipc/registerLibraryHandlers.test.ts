import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared/contracts";
import { LibraryWorkSession } from "../libraryWorkSession";

import { registerLibraryHandlers } from "./registerLibraryHandlers";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  dialog: vi.fn(),
  saveDialog: vi.fn(),
  copyFile: vi.fn(),
  spawn: vi.fn(),
  stat: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn()
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  copyFile: mocks.copyFile,
  stat: mocks.stat,
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rm
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("ffmpeg-static", () => ({ default: "/fake-ffmpeg" }));
vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.dialog, showSaveDialog: mocks.saveDialog },
  app: {},
  shell: {}
}));
vi.mock("./trustedSender", () => ({ requireTrustedSender: vi.fn() }));

const setup = (mediaWork?: LibraryWorkSession<undefined>) => {
  const order: string[] = [];
  const beforeLibraryChange = vi.fn(async () => {
    order.push("suspend");
    await mediaWork?.suspend();
  });
  const afterLibraryChange = vi.fn(() => {
    order.push("reset");
    mediaWork?.reset();
  });
  const open = vi.fn(async () => {
    order.push("open");
  });
  const settings = {
    assertWritable: vi.fn(),
    setLibraryRoot: vi.fn(async () => {
      order.push("settings");
    })
  };
  registerLibraryHandlers({
    settings,
    databaseManager: { open },
    repository: {
      assetSourcePath: async (id: string) => `/library/${id}.mp4`,
      getAsset: async () => ({ width: 1920, height: 1080 })
    },
    mediaWork,
    beforeLibraryChange,
    afterLibraryChange
  } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
  const getHandler = (channel: string) =>
    mocks.handle.mock.calls.find(([name]) => name === channel)![1];
  const handler = getHandler(IPC_CHANNELS.libraryChoose);
  mocks.dialog.mockResolvedValue({
    canceled: false,
    filePaths: ["/new-library"]
  });
  return {
    order,
    beforeLibraryChange,
    afterLibraryChange,
    open,
    handler,
    getHandler,
    settings
  };
};

beforeEach(() => vi.resetAllMocks());

describe("library-switch inference lifecycle", () => {
  it("drains old-library chat before opening and resets only after settings commit", async () => {
    const test = setup();
    await test.handler({ sender: {} });
    expect(test.order).toEqual(["suspend", "open", "settings", "reset"]);
  });

  it("does not reset after a failed open", async () => {
    const test = setup();
    test.open.mockRejectedValue(new Error("unavailable"));
    await expect(test.handler({ sender: {} })).rejects.toThrow("unavailable");
    expect(test.beforeLibraryChange).toHaveBeenCalledTimes(1);
    expect(test.afterLibraryChange).not.toHaveBeenCalled();
  });

  it("keeps old-library work running when folder selection is cancelled or unwritable", async () => {
    const test = setup();
    mocks.dialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await test.handler({ sender: {} })).toBeNull();
    test.settings.assertWritable.mockRejectedValue(new Error("read only"));
    await expect(test.handler({ sender: {} })).rejects.toThrow("read only");
    expect(test.beforeLibraryChange).not.toHaveBeenCalled();
    expect(test.open).not.toHaveBeenCalled();
  });
});

const saveInput = { assetId: "render" };
const sbsInput = {
  inputAssetId: "input",
  renderAssetId: "render",
  requestId: "request-1",
  suggestedName: "comparison.mp4",
  startFrame: 0,
  endFrame: 24,
  fps: 24
};
const approved = { canceled: false, filePath: "/export/video.mp4" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const createEvent = () => ({
  sender: { isDestroyed: () => false, send: vi.fn() }
});

describe("library-owned Save As", () => {
  it.each([
    [IPC_CHANNELS.filesSaveAssetAs, saveInput],
    [IPC_CHANNELS.filesExportSbsVideo, sbsInput]
  ])("does not wait for or honor an old %s dialog", async (channel, input) => {
    const test = setup();
    const approval = deferred<typeof approved>();
    mocks.saveDialog.mockReturnValueOnce(approval.promise);
    const event = createEvent();
    const saving = test.getHandler(channel)(event, input);
    await vi.waitFor(() => expect(mocks.saveDialog).toHaveBeenCalledOnce());

    await test.handler(event);
    expect(test.open).toHaveBeenCalledOnce();
    approval.resolve(approved);
    await expect(saving).resolves.toBe(false);
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(event.sender.send).not.toHaveBeenCalled();
  });

  it("drains an issued local copy and accepts a new account-free save after reset", async () => {
    const test = setup();
    const event = createEvent();
    const copy = deferred<void>();
    mocks.saveDialog.mockResolvedValue(approved);
    mocks.copyFile
      .mockReturnValueOnce(copy.promise)
      .mockResolvedValue(undefined);
    const save = test.getHandler(IPC_CHANNELS.filesSaveAssetAs);
    const saving = save(event, saveInput);
    await vi.waitFor(() => expect(mocks.copyFile).toHaveBeenCalledOnce());
    const switching = test.handler(event);
    await vi.waitFor(() =>
      expect(test.beforeLibraryChange).toHaveBeenCalledOnce()
    );
    expect(test.open).not.toHaveBeenCalled();
    copy.resolve();
    await expect(saving).resolves.toBe(false);
    await switching;

    await expect(save(event, saveInput)).resolves.toBe(true);
    expect(mocks.copyFile).toHaveBeenLastCalledWith(
      "/library/render.mp4",
      approved.filePath
    );
  });

  it("retires FFmpeg progress and drains child close and temp cleanup before opening", async () => {
    const work = new LibraryWorkSession(() => undefined);
    const test = setup(work);
    const event = createEvent();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn()
    });
    const cleanup = deferred<void>();
    mocks.saveDialog.mockResolvedValue(approved);
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.mkdtemp.mockResolvedValue("/tmp/comparison");
    mocks.spawn.mockReturnValue(child);
    mocks.rm.mockReturnValue(cleanup.promise);
    const exportVideo = test.getHandler(IPC_CHANNELS.filesExportSbsVideo);
    const exporting = exportVideo(event, sbsInput);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(event.sender.send).toHaveBeenCalledOnce();

    const switching = test.handler(event);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    child.stdout.emit("data", Buffer.from("out_time_us=500000\n"));
    child.emit("exit", 0);
    await Promise.resolve();
    expect(event.sender.send).toHaveBeenCalledOnce();
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(test.open).not.toHaveBeenCalled();

    child.emit("close", 0);
    await vi.waitFor(() =>
      expect(mocks.rm).toHaveBeenCalledWith("/tmp/comparison", {
        recursive: true,
        force: true
      })
    );
    expect(test.open).not.toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(exporting).resolves.toBe(false);
    await switching;
    expect(test.open).toHaveBeenCalledOnce();
  });

  it("saves a local comparison and reports completion without an account", async () => {
    const test = setup();
    const event = createEvent();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn()
    });
    mocks.saveDialog.mockResolvedValue(approved);
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.mkdtemp.mockResolvedValue("/tmp/comparison");
    mocks.spawn.mockReturnValue(child);
    const exporting = test.getHandler(IPC_CHANNELS.filesExportSbsVideo)(
      event,
      sbsInput
    );
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    child.emit("close", 0);

    await expect(exporting).resolves.toBe(true);
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/tmp/comparison/comparison.mp4",
      approved.filePath
    );
    expect(mocks.rm).toHaveBeenCalledOnce();
    expect(event.sender.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.filesSbsExportProgress,
      {
        requestId: sbsInput.requestId,
        percentage: 100
      }
    );
  });
});
