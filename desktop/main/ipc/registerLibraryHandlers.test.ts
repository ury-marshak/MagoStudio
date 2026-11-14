import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared/contracts";

import { registerLibraryHandlers } from "./registerLibraryHandlers";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), dialog: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.dialog },
  app: {},
  shell: {}
}));
vi.mock("./trustedSender", () => ({ requireTrustedSender: vi.fn() }));

const setup = () => {
  const order: string[] = [];
  const beforeLibraryChange = vi.fn(async () => {
    order.push("suspend");
  });
  const afterLibraryChange = vi.fn(() => {
    order.push("reset");
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
    repository: {},
    beforeLibraryChange,
    afterLibraryChange
  } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === IPC_CHANNELS.libraryChoose
  )![1];
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
