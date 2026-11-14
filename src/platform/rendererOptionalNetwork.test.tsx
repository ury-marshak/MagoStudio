import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  authPost: vi.fn(),
  push: vi.fn(),
  setApiKey: vi.fn(),
  rejectKey: vi.fn(),
  init: vi.fn(),
  add: vi.fn(),
  identify: vi.fn(),
  identifySet: vi.fn(),
  setUserId: vi.fn(),
  track: vi.fn(),
  flush: vi.fn(),
  replay: vi.fn(),
  gaInit: vi.fn(),
  gtag: vi.fn(),
  productFruits: vi.fn(),
  widget: vi.fn(),
  cookie: vi.fn(),
  tracked: vi.fn(),
  user: {
    id: "fixture-user",
    createdAt: new Date(),
    primaryEmailAddress: { emailAddress: "fixture@example.invalid" },
    emailAddresses: [{ emailAddress: "fixture@example.invalid" }],
    fullName: "Fixture",
    unsafeMetadata: {} as Record<string, unknown>,
    getSessions: vi.fn(),
    updateMetadata: vi.fn(),
    update: vi.fn()
  }
}));
vi.mock("@platform/identity", () => ({
  useUser: () => ({ user: mocks.user, isLoaded: true }),
  useAuth: () => ({
    getToken: mocks.getToken,
    isLoaded: true,
    isSignedIn: true
  }),
  useSession: () => ({ session: { id: "session" } })
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => "/project",
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("axios", async (original) => {
  const axios = await original<typeof import("axios")>();
  return { ...axios, default: { ...axios.default, post: mocks.authPost } };
});
vi.mock("@/lib/backend-api-client", () => ({
  API_URL: "https://backend.invalid/v02",
  initializeBackendApiClient: vi.fn(),
  registerUnauthorizedHandler: vi.fn(),
  setApiKey: mocks.setApiKey,
  rejectApiKeyInitialization: mocks.rejectKey
}));
vi.mock("@amplitude/analytics-browser", () => ({
  init: mocks.init,
  add: mocks.add,
  identify: mocks.identify,
  setUserId: mocks.setUserId,
  track: mocks.track,
  flush: mocks.flush,
  Identify: class {
    set = mocks.identifySet;
  }
}));
vi.mock("@amplitude/plugin-session-replay-browser", () => ({
  sessionReplayPlugin: mocks.replay
}));
vi.mock("react-ga4", () => ({
  default: { initialize: mocks.gaInit, gtag: mocks.gtag }
}));
vi.mock("react-product-fruits", () => ({
  ProductFruits: (props: unknown) => {
    mocks.productFruits(props);
    return null;
  }
}));
vi.mock("@typeform/embed-react", () => ({
  Widget: (props: unknown) => {
    mocks.widget(props);
    return null;
  }
}));
vi.mock("next/script", () => ({
  default: ({ src }: { src?: string }) => (
    <span data-testid="remote-script" data-src={src} />
  )
}));
vi.mock("@hooks/userLocalStorage/useUserLocalStorage", () => ({
  useUserLocalStorage: () => [false, mocks.tracked]
}));
vi.mock("@utils/hasAccountCookie", () => ({
  hasAccountCookie: () => false,
  setHasAccountCookie: mocks.cookie
}));
vi.mock("@domains/onboarding/useOnboardingProgress", () => ({
  useOnboardingProgress: () => [{}, vi.fn()]
}));
vi.mock("@hooks/useShallowRouter", () => ({
  useShallowRouter: () => ({ replace: vi.fn() })
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

let BackendApiProvider: (typeof import("@/providers/BackendApiProvider"))["BackendApiProvider"];
let AmplitudeProvider: (typeof import("@context/AmplitudeProvider"))["AmplitudeProvider"];
let AmplitudeUserTracking: (typeof import("@config/AmplitudeUserTracking"))["AmplitudeUserTracking"];
let GoogleTag: (typeof import("@config/GoogleTag"))["GoogleTag"];
let ProductFruitsProvider: (typeof import("@/providers/ProductFruitsProvider"))["ProductFruitsProvider"];
let RewardfulTracking: (typeof import("@config/RewardfulTracking"))["RewardfulTracking"];
let AttributionTracking: (typeof import("@config/AttributionTracking"))["AttributionTracking"];
let PricingContactForm: (typeof import("@/app/(authenticated)/(home)/pricing/components/PricingContactForm"))["PricingContactForm"];
let OnboardingTutorialModal: (typeof import("@/app/(authenticated)/(home)/components/onboarding/OnboardingTutorialModal"))["OnboardingTutorialModal"];
let useTrackSignUp: (typeof import("@/app/hooks/tracking/useTrackSignUp"))["useTrackSignUp"];
let useTawkTo: (typeof import("@/app/(authenticated)/(home)/project/components/HelpButton/TawkWidget/useTawk"))["useTawkTo"];
const setMode = (mode: unknown) => {
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { account: { mode } }
  });
};

beforeAll(async () => {
  for (const key of [
    "NEXT_PUBLIC_AMPLITUDE_API_KEY",
    "NEXT_PUBLIC_GOOGLE_TAG_ID",
    "NEXT_PUBLIC_PRODUCT_FRUITS_WORKSPACE_CODE",
    "NEXT_PUBLIC_REWARDFUL_API_KEY",
    "NEXT_PUBLIC_TYPEFORM_FORM_ID"
  ])
    vi.stubEnv(key, "fixture-configured");
  ({ BackendApiProvider } = await import("@/providers/BackendApiProvider"));
  ({ AmplitudeProvider } = await import("@context/AmplitudeProvider"));
  ({ AmplitudeUserTracking } = await import("@config/AmplitudeUserTracking"));
  ({ GoogleTag } = await import("@config/GoogleTag"));
  ({ ProductFruitsProvider } =
    await import("@/providers/ProductFruitsProvider"));
  ({ RewardfulTracking } = await import("@config/RewardfulTracking"));
  ({ AttributionTracking } = await import("@config/AttributionTracking"));
  ({ PricingContactForm } =
    await import("@/app/(authenticated)/(home)/pricing/components/PricingContactForm"));
  ({ OnboardingTutorialModal } =
    await import("@/app/(authenticated)/(home)/components/onboarding/OnboardingTutorialModal"));
  ({ useTrackSignUp } = await import("@/app/hooks/tracking/useTrackSignUp"));
  ({ useTawkTo } =
    await import("@/app/(authenticated)/(home)/project/components/HelpButton/TawkWidget/useTawk"));
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.clearAllMocks();
  setMode("offline");
  localStorage.clear();
  mocks.getToken.mockResolvedValue("synthetic-token");
  mocks.authPost.mockResolvedValue({ data: { api_key: "synthetic-key" } });
  mocks.init.mockReturnValue({ promise: Promise.resolve() });
  mocks.user.getSessions.mockResolvedValue([]);
  mocks.user.updateMetadata.mockResolvedValue(undefined);
  mocks.user.update.mockResolvedValue(undefined);
});
afterEach(() => {
  delete (window as { mago?: unknown }).mago;
  delete window.gtag;
  delete window.Tawk_API;
  delete window.Tawk_LoadStart;
  vi.restoreAllMocks();
});

const AnalyticsShell = () => (
  <AmplitudeProvider>
    <AmplitudeUserTracking />
    <GoogleTag />
    <ProductFruitsProvider />
    <RewardfulTracking />
    <AttributionTracking />
    <PricingContactForm />
    <span>local editor</span>
  </AmplitudeProvider>
);

describe("optional renderer network entry points", () => {
  it.each(["offline", "unchosen", undefined, "CLOUD"])(
    "does not initialize/enqueue SDKs or embeds in mode %s",
    async (mode) => {
      setMode(mode);
      localStorage.setItem(
        "google_analytics_client_id_pending",
        "historical-client"
      );
      render(<AnalyticsShell />);
      renderHook(() => useTrackSignUp());
      renderHook(() => useTawkTo({ showChat: true }));
      await act(async () => {});
      for (const trap of [
        mocks.init,
        mocks.add,
        mocks.identify,
        mocks.setUserId,
        mocks.track,
        mocks.flush,
        mocks.gaInit,
        mocks.gtag,
        mocks.productFruits,
        mocks.widget,
        mocks.user.getSessions,
        mocks.user.updateMetadata,
        mocks.cookie
      ])
        expect(trap).not.toHaveBeenCalled();
      expect(screen.getByText("local editor")).toBeInTheDocument();
      expect(screen.queryByTestId("remote-script")).not.toBeInTheDocument();
      expect(document.querySelector('script[src*="tawk"]')).toBeNull();
    }
  );
  it.each(["cloud", "web"])(
    "preserves %s SDK/embed behavior when deliberately mounted",
    async (mode) => {
      if (mode === "web") delete (window as { mago?: unknown }).mago;
      else setMode(mode);
      window.gtag = vi.fn();
      render(<AnalyticsShell />);
      renderHook(() => useTrackSignUp());
      await waitFor(() => expect(mocks.add).toHaveBeenCalled());
      for (const trap of [
        mocks.init,
        mocks.identify,
        mocks.setUserId,
        mocks.track,
        mocks.flush,
        mocks.gaInit,
        mocks.gtag,
        mocks.productFruits,
        mocks.widget,
        mocks.cookie
      ])
        expect(trap).toHaveBeenCalled();
      expect(screen.getAllByTestId("remote-script")).toHaveLength(2);
    }
  );
  it("does not turn a mounted backend provider into account-free credential permission", async () => {
    render(
      <BackendApiProvider>
        <span>local editor</span>
      </BackendApiProvider>
    );
    await act(async () => {});
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.authPost).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it.each(["cloud", "web"])("preserves %s auth exchange", async (mode) => {
    if (mode === "web") delete (window as { mago?: unknown }).mago;
    else setMode(mode);
    render(
      <BackendApiProvider>
        <span>editor</span>
      </BackendApiProvider>
    );
    await waitFor(() =>
      expect(mocks.setApiKey).toHaveBeenCalledWith("synthetic-key")
    );
    expect(mocks.authPost).toHaveBeenCalledWith(
      "https://backend.invalid/auth",
      {},
      { headers: { Authorization: "Bearer synthetic-token" } }
    );
  });
  it("refuses late auth dispatch after sign-out while token lookup was pending", async () => {
    setMode("cloud");
    let release!: (value: string) => void;
    mocks.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    render(
      <BackendApiProvider>
        <span>editor</span>
      </BackendApiProvider>
    );
    setMode("offline");
    await act(async () => release("old-token"));
    expect(mocks.authPost).not.toHaveBeenCalled();
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("drops an auth response after its provider unmounts", async () => {
    setMode("cloud");
    let release!: (value: unknown) => void;
    mocks.authPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const view = render(
      <BackendApiProvider>
        <span>editor</span>
      </BackendApiProvider>
    );
    await waitFor(() => expect(release).toBeDefined());
    view.unmount();
    await act(async () => release({ data: { api_key: "old-key" } }));
    expect(mocks.setApiKey).not.toHaveBeenCalled();
  });
  it("drops a late GA client-id callback after sign-out", async () => {
    setMode("cloud");
    window.gtag = vi.fn();
    let callback!: (id: string) => void;
    mocks.gtag.mockImplementationOnce((_command, _id, _field, cb) => {
      callback = cb;
    });
    render(<GoogleTag />);
    setMode("offline");
    await act(async () => callback("late-client"));
    expect(mocks.user.updateMetadata).not.toHaveBeenCalled();
    expect(
      localStorage.getItem("google_analytics_client_id_pending")
    ).toBeNull();
  });
  it("does not follow a delayed attribution session lookup into metadata writes", async () => {
    setMode("cloud");
    let release!: (value: unknown[]) => void;
    mocks.user.getSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    localStorage.setItem(
      "utm_pending",
      JSON.stringify({ utm_source: "fixture" })
    );
    render(<AttributionTracking />);
    setMode("offline");
    await act(async () => release([]));
    expect(mocks.user.updateMetadata).not.toHaveBeenCalled();
  });
  it("opens tutorial only on explicit click outside the account-free app, without thumbnail/embed", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = render(<OnboardingTutorialModal />);
    expect(view.container.querySelector("img[src]")).toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "actions.play_tutorial.label" })
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("https://www.youtube.com/watch?v="),
      "_blank",
      "noopener,noreferrer"
    );
    expect(view.container.querySelector("iframe")).toBeNull();
  });
  it.each(["cloud", "web"])(
    "preserves %s tutorial thumbnail/embed",
    async (mode) => {
      if (mode === "web") delete (window as { mago?: unknown }).mago;
      else setMode(mode);
      const view = render(<OnboardingTutorialModal />);
      expect(
        view.container.querySelector("img[src]")?.getAttribute("src")
      ).toContain("img.youtube.com");
      fireEvent.click(
        screen.getByRole("button", { name: "actions.play_tutorial.label" })
      );
      expect(
        view.container.querySelector("iframe")?.getAttribute("src")
      ).toContain("youtube.com/embed/");
    }
  );
});

it("does not attach a deferred session-replay plugin after sign-out", async () => {
  setMode("cloud");
  render(
    <AmplitudeProvider>
      <span>editor</span>
    </AmplitudeProvider>
  );
  setMode("offline");
  await act(async () => {});
  expect(mocks.init).toHaveBeenCalledOnce();
  expect(mocks.add).not.toHaveBeenCalled();
});

it("stops GA retry callbacks after sign-out", async () => {
  vi.useFakeTimers();
  try {
    setMode("cloud");
    render(<GoogleTag />);
    setMode("offline");
    window.gtag = vi.fn();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.gtag).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
