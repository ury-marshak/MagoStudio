import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared/contracts";

import { registerScriptProjectHandlers } from "./registerScriptProjectHandlers";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), trusted: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("./trustedSender", () => ({ requireTrustedSender: mocks.trusted }));

const setup = (channel: string = IPC_CHANNELS.scriptProjectsCancelChat) => {
  const controller = new AbortController();
  const cancel = vi.fn(async () => true);
  const post = vi.fn();
  const list = vi.fn();
  const databaseManager = { isOpen: vi.fn(() => true), open: vi.fn() };
  registerScriptProjectHandlers({
    chat: { cancel, post, list, getSessionSignal: () => controller.signal },
    databaseManager,
    repository: {},
    service: {},
    settings: {}
  } as unknown as Parameters<typeof registerScriptProjectHandlers>[0]);
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === channel
  )![1];
  return { cancel, post, list, controller, databaseManager, handler };
};

beforeEach(() => vi.resetAllMocks());

describe("Director chat cancellation IPC", () => {
  it("accepts turn- and project-scoped cancellation", async () => {
    const test = setup();
    expect(
      await test.handler({}, { projectId: "project", messageId: "reply" })
    ).toBe(true);
    expect(test.cancel).toHaveBeenLastCalledWith("project", "reply");
    await test.handler({}, { projectId: "project" });
    expect(test.cancel).toHaveBeenLastCalledWith("project", undefined);
  });

  it.each([
    null,
    [],
    {},
    { projectId: " " },
    { projectId: "project", messageId: "" },
    { projectId: "project", messageId: 12 },
    { projectId: 12 }
  ])("rejects malformed input %j", async (input) => {
    const test = setup();
    await expect(test.handler({}, input)).rejects.toThrow();
    expect(test.cancel).not.toHaveBeenCalled();
  });

  it("checks sender trust before database access or cancellation", async () => {
    const test = setup();
    mocks.trusted.mockImplementationOnce(() => {
      throw new Error("untrusted");
    });
    await expect(test.handler({}, { projectId: "project" })).rejects.toThrow(
      "untrusted"
    );
    expect(test.databaseManager.isOpen).not.toHaveBeenCalled();
    expect(test.cancel).not.toHaveBeenCalled();
  });

  it.each([
    IPC_CHANNELS.scriptProjectsChatMessage,
    IPC_CHANNELS.scriptProjectsChatMessages,
    IPC_CHANNELS.scriptProjectsCancelChat
  ])(
    "refuses %s during library teardown, before database setup",
    async (channel) => {
      const test = setup(channel);
      test.controller.abort();
      await expect(
        test.handler({}, { projectId: "project", message: "hello" })
      ).rejects.toThrow();
      expect(test.databaseManager.isOpen).not.toHaveBeenCalled();
      expect(test.cancel).not.toHaveBeenCalled();
      expect(test.post).not.toHaveBeenCalled();
      expect(test.list).not.toHaveBeenCalled();
    }
  );

  it.each([
    IPC_CHANNELS.scriptProjectsChatMessage,
    IPC_CHANNELS.scriptProjectsChatMessages,
    IPC_CHANNELS.scriptProjectsCancelChat
  ])(
    "does not retarget %s if teardown happens during database setup",
    async (channel) => {
      const test = setup(channel);
      test.databaseManager.isOpen.mockImplementationOnce(() => {
        test.controller.abort();
        return true;
      });
      await expect(
        test.handler({}, { projectId: "project", message: "hello" })
      ).rejects.toThrow();
      expect(test.cancel).not.toHaveBeenCalled();
      expect(test.post).not.toHaveBeenCalled();
      expect(test.list).not.toHaveBeenCalled();
    }
  );
});
