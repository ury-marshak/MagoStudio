import { fireEvent } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test-utils/renderWithProviders";

import { ScriptChat } from "./ScriptChat";

beforeAll(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
});

const setup = (isWaitingForReply: boolean, onCancel?: () => void) =>
  renderWithProviders(
    <ScriptChat
      messages={[]}
      draft=""
      isWaitingForReply={isWaitingForReply}
      isScriptLockedAfterSending={false}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onCancel={onCancel}
    />
  );

describe("Director chat cancellation control", () => {
  it("cancels a pending turn explicitly", () => {
    const cancel = vi.fn();
    const screen = setup(true, cancel);
    fireEvent.click(screen.getByTestId("script-chat-cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not offer cancellation for completed turns or unsupported routes", () => {
    expect(
      setup(false, vi.fn()).queryByTestId("script-chat-cancel")
    ).toBeNull();
    expect(setup(true).queryByTestId("script-chat-cancel")).toBeNull();
  });
});
