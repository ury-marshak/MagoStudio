import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/queryKeys";

import { useScriptChat } from "./useScriptChat";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  report: vi.fn(),
  rows: [] as Array<Record<string, unknown>>
}));
vi.mock("./api/cancelScriptChatReply", () => ({
  cancelScriptChatReply: mocks.cancel
}));
vi.mock("./data/useGetScriptChatMessages", () => ({
  useGetScriptChatMessages: () => ({
    data: {
      pending: mocks.rows.some((row) => row.status === "PENDING"),
      messages: mocks.rows
    },
    isError: false,
    refetch: vi.fn()
  })
}));
vi.mock("./data/usePostScriptChatMessage", () => ({
  usePostScriptChatMessage: () => ({ mutate: vi.fn(), isPending: false })
}));
vi.mock("./useSaveProjectSettingsPatch", () => ({
  useSaveProjectSettingsPatch: () => ({
    project: undefined,
    saveProjectSettingsPatch: vi.fn()
  })
}));
vi.mock("./useReportScriptProjectFailure", () => ({
  useReportScriptProjectFailure: () => mocks.report
}));

const setup = () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ projectId }) =>
      useScriptChat({
        projectId,
        scriptBoxText: "",
        onScriptWritten: vi.fn(),
        onRefusal: vi.fn(),
        onFailedMessageResent: vi.fn()
      }),
    { wrapper, initialProps: { projectId: "old-project" } }
  );
  return { ...hook, invalidate };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rows = [
    { id: "reply", role: "assistant", status: "PENDING", content: "" }
  ];
});

describe("Director chat cancellation hook", () => {
  it("cancels the displayed turn and invalidates its original project after navigation", async () => {
    let finish!: (value: boolean) => void;
    mocks.cancel.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    const test = setup();
    expect(test.result.current.canCancelReply).toBe(true);
    act(() => test.result.current.cancelReply());
    await waitFor(() =>
      expect(mocks.cancel).toHaveBeenCalledWith(
        { projectId: "old-project", messageId: "reply" },
        expect.anything()
      )
    );
    await waitFor(() => expect(test.result.current.canCancelReply).toBe(false));
    test.rerender({ projectId: "new-project" });
    await act(async () => finish(true));
    expect(test.invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.scriptChatMessages.byProjectId("old-project")
    });
    test.unmount();
  });

  it("reports a cancellation failure once without retrying", async () => {
    mocks.cancel.mockRejectedValue(new Error("unavailable"));
    const test = setup();
    act(() => test.result.current.cancelReply());
    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(1));
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(test.result.current.canCancelReply).toBe(true));
    test.unmount();
  });

  it("does not cancel merely because a tab unmounts, and has no action without a pending reply", () => {
    const pending = setup();
    pending.unmount();
    expect(mocks.cancel).not.toHaveBeenCalled();
    mocks.rows = [];
    const completed = setup();
    expect(completed.result.current.canCancelReply).toBe(false);
    act(() => completed.result.current.cancelReply());
    expect(mocks.cancel).not.toHaveBeenCalled();
    completed.unmount();
  });
});
