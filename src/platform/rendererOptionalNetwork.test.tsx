import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from "@testing-library/react";
import type { WebContents } from "electron";
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

import {
  createAccountLifecycle,
  registerAccountHandlers
} from "../../desktop/main/ipc/registerAccountHandlers";
import { ProfileLifetime } from "../../desktop/main/providers/profileLifetime";
import {
  IPC_CHANNELS,
  type MagoDesktopApi
} from "../../desktop/shared/contracts";

const desktop = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Listener>();
  const mainListeners = new Map<string, Listener>();
  const listeners = new Map<string, Set<Listener>>();
  const makeSender = () => ({
    isDestroyed: vi.fn(() => false),
    mainFrame: { url: "http://localhost:3000/" },
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn((channel: string, ...args: unknown[]) =>
      listeners.get(channel)?.forEach((listener) => listener({}, ...args))
    )
  });
  const sender = makeSender();
  return {
    handlers,
    mainListeners,
    listeners,
    makeSender,
    sender,
    event: (origin = sender) => ({
      sender: origin,
      senderFrame: origin.mainFrame,
      returnValue: false
    }),
    api: null as unknown as MagoDesktopApi
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (
      channel: string,
      handler: Parameters<typeof desktop.handlers.set>[1]
    ) => desktop.handlers.set(channel, handler),
    on: (
      channel: string,
      listener: Parameters<typeof desktop.mainListeners.set>[1]
    ) => desktop.mainListeners.set(channel, listener)
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) =>
      desktop.handlers.get(channel)!(desktop.event(), ...args),
    send: (channel: string, ...args: unknown[]) =>
      desktop.mainListeners.get(channel)?.(desktop.event(), ...args),
    sendSync: (channel: string) => {
      const event = desktop.event();
      desktop.mainListeners.get(channel)?.(event);
      return event.returnValue;
    },
    on: (
      channel: string,
      listener: Parameters<typeof desktop.handlers.set>[1]
    ) => {
      if (!desktop.listeners.has(channel))
        desktop.listeners.set(channel, new Set());
      desktop.listeners.get(channel)?.add(listener);
    },
    removeListener: (
      channel: string,
      listener: Parameters<typeof desktop.handlers.set>[1]
    ) => desktop.listeners.get(channel)?.delete(listener)
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MagoDesktopApi) => {
      desktop.api = api;
    }
  },
  webUtils: {}
}));

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  authPost: vi.fn(),
  push: vi.fn(),
  setApiKey: vi.fn(),
  rejectKey: vi.fn(),
  unauthorized: vi.fn<(handler: () => void) => void>(),
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
  registerUnauthorizedHandler: mocks.unauthorized,
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
      {
        signal: expect.any(AbortSignal),
        headers: { Authorization: "Bearer synthetic-token" }
      }
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
  const accountFixture = async (
    rebuildWindow = vi.fn(async () => {}),
    drainRetired = vi.fn(async () => {})
  ) => {
    desktop.listeners.clear();
    vi.resetModules();
    await import("../../desktop/preload/preload");
    const account = { ...desktop.api.account, mode: "cloud" as const };
    Object.defineProperty(window, "mago", {
      configurable: true,
      value: { account }
    });
    const profiles = new ProfileLifetime();
    const lifecycle = createAccountLifecycle(profiles, { drainRetired });
    const bindWindow = () => {
      const sender = desktop.makeSender();
      sender.send.mockImplementation((channel) => {
        if (channel === IPC_CHANNELS.accountRetired) {
          desktop.mainListeners.get(IPC_CHANNELS.accountRetiredAck)?.(
            desktop.event(sender)
          );
        }
      });
      lifecycle.bindWindow(sender as unknown as WebContents);
      return sender;
    };
    const notifyRenderer = (channel: string, ...args: unknown[]) =>
      desktop.listeners
        .get(channel)
        ?.forEach((listener) => listener({}, ...args));
    desktop.sender.send.mockReset().mockImplementation(notifyRenderer);
    lifecycle.bindWindow(desktop.sender as unknown as WebContents);
    let persistedMode: "cloud" | "offline" | null = "cloud";
    const settings = {
      setAppMode: vi.fn(async (mode: "cloud" | "offline") => {
        persistedMode = mode;
      }),
      clearAppMode: vi.fn(async () => {
        persistedMode = null;
      })
    };
    registerAccountHandlers({ settings, lifecycle, rebuildWindow });
    return {
      account,
      settings,
      profiles,
      lifecycle,
      bindWindow,
      notifyRenderer,
      mode: () => persistedMode
    };
  };

  it.each(["success", "failure"])(
    "drops old /auth %s during a deferred account-window rebuild in the same library",
    async (outcome) => {
      const auth = Promise.withResolvers<unknown>();
      mocks.authPost.mockReturnValueOnce(auth.promise);
      const rebuilding = Promise.withResolvers<void>();
      const rebuildWindow = vi.fn(() => rebuilding.promise);
      const { account, mode } = await accountFixture(rebuildWindow);
      // Even if the page-level subscription misses retirement, read the
      // authoritative status rather than accepting an error late.
      if (outcome === "failure") account.onRetired = () => () => undefined;
      render(
        <BackendApiProvider>
          <span>same library editor</span>
        </BackendApiProvider>
      );
      await waitFor(() => expect(mocks.authPost).toHaveBeenCalledOnce());
      const signal: AbortSignal = mocks.authPost.mock.calls[0][2].signal;
      const transition = account.chooseMode("offline");
      try {
        await waitFor(() => expect(rebuildWindow).toHaveBeenCalledOnce());
        expect(mode()).toBe("offline");
        expect(account.mode).toBe("cloud"); // Baked into the still-mounted old window.
        if (outcome === "success") expect(signal.aborted).toBe(true);
        await act(async () => {
          if (outcome === "success")
            auth.resolve({ data: { api_key: "retired-key" } });
          else auth.reject(new Error("retired exchange"));
        });
        mocks.unauthorized.mock.calls[0][0]();
        expect(signal.aborted).toBe(true);
        expect(mocks.setApiKey).not.toHaveBeenCalled();
        expect(mocks.rejectKey).not.toHaveBeenCalled();
        expect(mocks.push).not.toHaveBeenCalled();
        expect(mocks.authPost).toHaveBeenCalledOnce();
        expect(screen.getByText("same library editor")).toBeInTheDocument();
      } finally {
        rebuilding.resolve();
        await transition;
      }
    }
  );

  it("waits for the trusted preload and main teardown before persisting an account change", async () => {
    const drain = Promise.withResolvers<void>();
    const drainRetired = vi.fn(() => drain.promise);
    const { account, mode, notifyRenderer, settings } = await accountFixture(
      undefined,
      drainRetired
    );
    const auth = Promise.withResolvers<unknown>();
    mocks.authPost.mockReturnValueOnce(auth.promise);
    render(
      <BackendApiProvider>
        <span>same library editor</span>
      </BackendApiProvider>
    );
    await waitFor(() => expect(mocks.authPost).toHaveBeenCalledOnce());
    desktop.sender.send.mockImplementation(() => undefined);
    const transition = account.chooseMode("offline");
    await waitFor(() =>
      expect(desktop.sender.send).toHaveBeenCalledWith(
        IPC_CHANNELS.accountRetired
      )
    );
    expect(account.isCurrent()).toBe(false);
    const acknowledge = desktop.mainListeners.get(
      IPC_CHANNELS.accountRetiredAck
    )!;
    acknowledge(desktop.event(desktop.makeSender()));
    acknowledge({
      ...desktop.event(),
      senderFrame: { ...desktop.sender.mainFrame }
    });
    await act(async () =>
      auth.resolve({ data: { api_key: "retired-before-ack" } })
    );
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(drainRetired).not.toHaveBeenCalled();
    expect(settings.setAppMode).not.toHaveBeenCalled();
    notifyRenderer(IPC_CHANNELS.accountRetired);
    await waitFor(() => expect(drainRetired).toHaveBeenCalledOnce());
    expect(mode()).toBe("cloud");
    drain.resolve();
    await transition;
    expect(mode()).toBe("offline");
  });

  it("fails closed without writing if the old preload never acknowledges retirement", async () => {
    const { account, settings } = await accountFixture();
    desktop.sender.send.mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const rejected = expect(account.chooseMode("offline")).rejects.toThrow(
        "Account window retirement timed out"
      );
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(account.isCurrent()).toBe(false);
      expect(settings.setAppMode).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires the window while Clerk is pending, and only that window can finish sign-out", async () => {
    const token = Promise.withResolvers<string>();
    mocks.getToken.mockReturnValueOnce(token.promise);
    const { account, settings, mode } = await accountFixture();
    render(
      <BackendApiProvider>
        <span>same library editor</span>
      </BackendApiProvider>
    );
    await waitFor(() => expect(mocks.getToken).toHaveBeenCalledOnce());
    await expect(account.signOut()).rejects.toThrow("did not begin sign-out");
    await account.beginSignOut();
    expect(mode()).toBe("cloud");
    expect(settings.clearAppMode).not.toHaveBeenCalled();
    expect(account.isCurrent()).toBe(false);
    await act(async () => token.resolve("retired-token"));
    expect(mocks.authPost).not.toHaveBeenCalled();
    await expect(
      desktop.handlers.get(IPC_CHANNELS.accountSignOut)!(
        desktop.event(desktop.makeSender())
      )
    ).rejects.toThrow("did not begin sign-out");
    await account.signOut();
    expect(mode()).toBeNull();
    expect(account.isCurrent()).toBe(false);
  });

  it("serializes account writes and rejects the original window after Cloud → offline → Cloud", async () => {
    const saving = Promise.withResolvers<void>();
    const auth = Promise.withResolvers<unknown>();
    mocks.authPost.mockReturnValueOnce(auth.promise);
    const rebuildWindow = vi.fn(async () => {});
    const { account, settings, bindWindow, mode } =
      await accountFixture(rebuildWindow);
    const current = desktop.mainListeners.get(IPC_CHANNELS.accountIsCurrent)!;
    const choose = desktop.handlers.get(IPC_CHANNELS.accountChooseMode)!;
    const iframe = {
      ...desktop.event(),
      senderFrame: { ...desktop.sender.mainFrame }
    };
    await expect(choose(iframe, "offline")).rejects.toThrow(
      "main window frame"
    );
    await expect(account.chooseMode("invalid" as "offline")).rejects.toThrow(
      "Unknown Mago app mode"
    );
    expect(account.isCurrent()).toBe(true);
    render(
      <BackendApiProvider>
        <span>same library editor</span>
      </BackendApiProvider>
    );
    await waitFor(() => expect(mocks.authPost).toHaveBeenCalledOnce());
    const persist = settings.setAppMode.getMockImplementation()!;
    settings.setAppMode.mockImplementationOnce(async (next) => {
      await saving.promise;
      await persist(next);
    });
    const first = account.chooseMode("offline");
    const queued = expect(account.chooseMode("cloud")).rejects.toMatchObject({
      name: "AbortError"
    });
    await waitFor(() => expect(settings.setAppMode).toHaveBeenCalledOnce());
    expect(account.isCurrent()).toBe(false);
    expect(rebuildWindow).not.toHaveBeenCalled();
    saving.resolve();
    await first;
    await queued;
    expect(mode()).toBe("offline");
    const offline = bindWindow();
    await choose(desktop.event(offline), "cloud");
    const replacement = desktop.event(bindWindow());
    current(replacement);
    expect(mode()).toBe("cloud");
    expect(replacement.returnValue).toBe(true);
    expect(account.isCurrent()).toBe(false);
    await act(async () =>
      auth.resolve({ data: { api_key: "retired-before-aba" } })
    );
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.authPost).toHaveBeenCalledOnce();
    await expect(account.chooseMode("offline")).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(settings.setAppMode.mock.calls).toEqual([["offline"], ["cloud"]]);
  });

  it.each(["persistence", "replacement"])(
    "does not re-authorize the old window after failed %s",
    async (failure) => {
      const rebuildWindow = vi.fn(async () => {});
      const { account, settings, profiles, mode, bindWindow, lifecycle } =
        await accountFixture(rebuildWindow);
      const error = new Error("account transition failed");
      let provisional: AbortSignal | undefined;
      if (failure === "persistence")
        settings.setAppMode.mockRejectedValueOnce(error);
      else
        rebuildWindow.mockImplementationOnce(async () => {
          provisional = lifecycle.capture(
            bindWindow() as unknown as WebContents
          );
          expect(provisional.aborted).toBe(false);
          throw error;
        });
      await expect(account.chooseMode("offline")).rejects.toThrow(
        error.message
      );
      expect(mode()).toBe(failure === "persistence" ? "cloud" : "offline");
      if (failure === "replacement") expect(provisional?.aborted).toBe(true);
      expect(account.isCurrent()).toBe(false);
      expect(() => profiles.capture()).toThrow();
      await expect(account.beginSignOut()).rejects.toMatchObject({
        name: "AbortError"
      });
      if (failure === "persistence")
        expect(rebuildWindow).not.toHaveBeenCalled();
    }
  );

  it("serializes the direct startup fallback write and holds admission until offline window binding", async () => {
    const { account, bindWindow, lifecycle, mode, profiles, settings } =
      await accountFixture();
    const previous = profiles.capture();
    const saving = Promise.withResolvers<void>();
    const persist = settings.setAppMode.getMockImplementation()!;
    settings.setAppMode.mockImplementationOnce(async (next) => {
      expect(previous.aborted).toBe(true);
      await saving.promise;
      await persist(next);
    });
    const openOfflineWindow = vi.fn(async () => {
      expect(mode()).toBe("offline");
      expect(() => profiles.capture()).toThrow();
      bindWindow();
    });
    const fallback = lifecycle.serialize(() =>
      lifecycle.replace(() => settings.setAppMode("offline"), openOfflineWindow)
    );
    const stale = expect(account.chooseMode("cloud")).rejects.toMatchObject({
      name: "AbortError"
    });
    await waitFor(() => expect(settings.setAppMode).toHaveBeenCalledOnce());
    expect(mode()).toBe("cloud");
    expect(account.isCurrent()).toBe(false);
    expect(openOfflineWindow).not.toHaveBeenCalled();
    saving.resolve();
    await fallback;
    await stale;
    expect(profiles.capture().aborted).toBe(false);
    expect(account.isCurrent()).toBe(false);
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
