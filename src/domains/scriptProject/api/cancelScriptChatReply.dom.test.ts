import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelScriptChatReply } from "./cancelScriptChatReply";

afterEach(() => {
  Reflect.deleteProperty(window, "mago");
});

const setup = (origin: "cloud" | "local") => {
  const cancelChat = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: {
      projects: { get: vi.fn().mockResolvedValue({ id: "project", origin }) },
      scriptProjects: { cancelChat }
    }
  });
  return cancelChat;
};

describe("cancelScriptChatReply", () => {
  it("sends a specific reply ID through the local bridge", async () => {
    const cancel = setup("local");
    expect(
      await cancelScriptChatReply({ projectId: "project", messageId: "reply" })
    ).toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      projectId: "project",
      messageId: "reply"
    });
  });

  it("does not fall back to another provider or cloud API", async () => {
    const cancel = setup("cloud");
    await expect(
      cancelScriptChatReply({ projectId: "project", messageId: "reply" })
    ).rejects.toThrow("only available for local");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("surfaces bridge failures without retry", async () => {
    const cancel = setup("local");
    cancel.mockRejectedValue(new Error("library unavailable"));
    await expect(
      cancelScriptChatReply({ projectId: "project", messageId: "reply" })
    ).rejects.toThrow("library unavailable");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
