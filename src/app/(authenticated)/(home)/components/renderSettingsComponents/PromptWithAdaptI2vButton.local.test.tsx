import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { atom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PromptWithAdaptI2vButton } from "./PromptWithAdaptI2vButton.local";

const mocks = vi.hoisted(() => ({
  route: "cloud",
  adaptCloud: vi.fn(),
  adaptLocal: vi.fn(),
  hasExternalText: vi.fn(),
  showToast: vi.fn()
}));
let sourcesAtom = atom([]);
vi.mock("@store/renderSettingsStore", () => ({
  useRenderSettingsAtoms: () => ({ sourcesAtom })
}));
vi.mock("@domains/track/useSourceVideoTrackId", () => ({
  useSourceVideoTrackId: () => "track"
}));
vi.mock("@domains/track/useSourceVideoAssetId", () => ({
  useSourceVideoAssetId: () => "video"
}));
vi.mock("@domains/prompt/useTextModelRoute", () => ({
  useTextModelRoute: () => ({ route: mocks.route, isRoutePending: false })
}));
vi.mock("@domains/prompt/api/adaptCloudI2vPromptFromLocal", () => ({
  adaptCloudI2vPromptFromLocal: mocks.adaptCloud
}));
vi.mock("@domains/prompt/api/postLocalAdaptI2vPrompt", () => ({
  postLocalAdaptI2vPrompt: mocks.adaptLocal
}));
vi.mock("@store/useToast", () => ({
  useToast: () => ({ showToast: mocks.showToast })
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: false,
  getLocalDesktopApi: () => ({
    vlm: { hasExternalText: mocks.hasExternalText }
  })
}));
vi.mock("./PromptWithRewriteButton", () => ({
  PromptWithRewriteButton: ({
    rewritePrompt,
    isRewritingPrompt
  }: {
    rewritePrompt: () => void;
    isRewritingPrompt: boolean;
  }) => (
    <button disabled={isRewritingPrompt} onClick={rewritePrompt}>
      Rewrite
    </button>
  )
}));

const props = {
  name: "prompt",
  label: "Prompt",
  ariaLabel: "Prompt",
  labelCaption: "",
  tooltip: "",
  defaultValue: undefined,
  value: "original",
  setValue: vi.fn()
};
const renderPrompt = () => {
  const client = new QueryClient();
  return render(<PromptWithAdaptI2vButton key="prompt" {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  });
};
const startRewrite = async (transport: typeof mocks.adaptCloud) => {
  let signal!: AbortSignal;
  let finish!: (response: { adapted: boolean; adapted_prompt: string }) => void;
  transport.mockImplementationOnce((...args) => {
    signal = args.at(-1);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
  });
  expect(transport).toHaveBeenCalledOnce();
  return { signal, finish };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.route = "cloud";
  sourcesAtom = atom([]);
  mocks.hasExternalText.mockResolvedValue(false);
});

describe("desktop prompt rewrite settlement", () => {
  it.each([
    ["cloud", "local", mocks.adaptCloud],
    ["local", "cloud", mocks.adaptLocal]
  ] as const)(
    "drops a late %s result when the route becomes %s",
    async (from, to, transport) => {
      mocks.route = from;
      const { rerender } = renderPrompt();
      const old = await startRewrite(transport);
      mocks.route = to;
      rerender(<PromptWithAdaptI2vButton key="prompt" {...props} />);
      expect(old.signal.aborted).toBe(true);
      await act(async () => {
        old.finish({ adapted: true, adapted_prompt: "stale" });
      });
      expect(props.setValue).not.toHaveBeenCalled();
      expect(mocks.showToast).not.toHaveBeenCalled();
    }
  );

  it.each(["value", "target"] as const)(
    "drops a late cloud result after an editor %s change",
    async (change) => {
      const { rerender } = renderPrompt();
      const old = await startRewrite(mocks.adaptCloud);
      if (change === "target") sourcesAtom = atom([]);
      const setValue = vi.fn();
      rerender(
        <PromptWithAdaptI2vButton
          key="prompt"
          {...props}
          value={change === "value" ? "edited" : props.value}
          setValue={setValue}
        />
      );
      expect(old.signal.aborted).toBe(true);
      await act(async () => {
        old.finish({ adapted: false, adapted_prompt: "stale" });
      });
      expect(props.setValue).not.toHaveBeenCalled();
      expect(setValue).not.toHaveBeenCalled();
      expect(mocks.showToast).not.toHaveBeenCalled();
    }
  );
});
