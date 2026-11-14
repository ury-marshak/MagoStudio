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
  const metrics = vi.fn();
  const captureMetricsSession = vi.fn(() => {
    controller.signal.throwIfAborted();
    return controller.signal;
  });
  const update = vi.fn();
  const captureDescriptionSession = vi.fn(() => {
    controller.signal.throwIfAborted();
    return controller.signal;
  });
  const databaseManager = { isOpen: vi.fn(() => true), open: vi.fn() };
  registerScriptProjectHandlers({
    chat: { cancel, post, list, getSessionSignal: () => controller.signal },
    databaseManager,
    service: {
      inLibrary: async (operation: () => Promise<unknown>) => operation(),
      capturePlanSession: () => {
        controller.signal.throwIfAborted();
        return controller.signal;
      },
      databaseOperation: async (operation: () => Promise<unknown>) =>
        operation(),
      getRenderMetrics: metrics,
      captureMetricsSession,
      update,
      captureDescriptionSession
    },
    settings: {}
  } as unknown as Parameters<typeof registerScriptProjectHandlers>[0]);
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === channel
  )![1];
  return {
    cancel,
    post,
    list,
    controller,
    databaseManager,
    handler,
    metrics,
    captureMetricsSession,
    update,
    captureDescriptionSession
  };
};

describe("Director sheet description session IPC", () => {
  it("forwards the captured session to updates", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsUpdate);
    const input = {
      projectId: "project",
      operation: "describe-sheet",
      payload: { token: "hero" }
    };
    await test.handler({}, input);
    expect(test.update).toHaveBeenCalledWith(input, test.controller.signal);
  });

  it("checks trust before session capture or database access", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsUpdate);
    mocks.trusted.mockImplementationOnce(() => {
      throw new Error("untrusted");
    });
    await expect(test.handler({}, {})).rejects.toThrow("untrusted");
    expect(test.captureDescriptionSession).not.toHaveBeenCalled();
    expect(test.databaseManager.isOpen).not.toHaveBeenCalled();
  });

  it("refuses updates during teardown before database setup", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsUpdate);
    test.controller.abort();
    await expect(test.handler({}, {})).rejects.toThrow();
    expect(test.databaseManager.isOpen).not.toHaveBeenCalled();
    expect(test.update).not.toHaveBeenCalled();
  });

  it("does not retarget updates when teardown crosses database setup", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsUpdate);
    test.databaseManager.isOpen.mockImplementationOnce(() => {
      test.controller.abort();
      return true;
    });
    await expect(test.handler({}, {})).rejects.toThrow();
    expect(test.update).not.toHaveBeenCalled();
  });

  it.each([null, [], "invalid"])(
    "rejects malformed updates %j",
    async (input) => {
      const test = setup(IPC_CHANNELS.scriptProjectsUpdate);
      await expect(test.handler({}, input)).rejects.toThrow();
      expect(test.update).not.toHaveBeenCalled();
    }
  );
});

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

describe("Director metrics session IPC", () => {
  it("captures the library session and forwards it to metrics", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsGetRenderMetrics);
    await test.handler({}, "video");
    expect(test.metrics).toHaveBeenCalledWith("video", test.controller.signal);
  });

  it("checks trust before session or database access", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsGetRenderMetrics);
    mocks.trusted.mockImplementationOnce(() => {
      throw new Error("untrusted");
    });
    await expect(test.handler({}, "video")).rejects.toThrow("untrusted");
    expect(test.captureMetricsSession).not.toHaveBeenCalled();
    expect(test.databaseManager.isOpen).not.toHaveBeenCalled();
  });

  it("refuses a request during teardown before database setup", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsGetRenderMetrics);
    test.controller.abort();
    await expect(test.handler({}, "video")).rejects.toThrow();
    expect(test.databaseManager.isOpen).not.toHaveBeenCalled();
    expect(test.metrics).not.toHaveBeenCalled();
  });

  it("cannot retarget an identical ID when database setup crosses teardown", async () => {
    const test = setup(IPC_CHANNELS.scriptProjectsGetRenderMetrics);
    test.databaseManager.isOpen.mockImplementationOnce(() => {
      test.controller.abort();
      return true;
    });
    await expect(test.handler({}, "video")).rejects.toThrow();
    expect(test.metrics).not.toHaveBeenCalled();
  });

  it.each([null, 42, " "])("rejects invalid asset IDs %j", async (id) => {
    const test = setup(IPC_CHANNELS.scriptProjectsGetRenderMetrics);
    await expect(test.handler({}, id)).rejects.toThrow();
    expect(test.metrics).not.toHaveBeenCalled();
  });
});
