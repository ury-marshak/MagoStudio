import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi
} from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  optOut: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  replay: vi.fn(),
  teardown: vi.fn(),
  identify: vi.fn(),
  setUserId: vi.fn(),
  gaInit: vi.fn(),
  gtag: vi.fn(),
  fruitsUnmount: vi.fn(),
  fruitsMount: vi.fn(),
  user: {
    id: "fixture",
    createdAt: new Date(0),
    primaryEmailAddress: { emailAddress: "fixture@example.invalid" },
    emailAddresses: [{ emailAddress: "fixture@example.invalid" }],
    unsafeMetadata: {},
    getSessions: vi.fn(),
    updateMetadata: vi.fn()
  }
}));

vi.mock("@platform/identity", () => ({
  useUser: () => ({ user: sdk.user, isLoaded: true }),
  useSession: () => ({ session: { id: "fixture-session" } })
}));
vi.mock("@amplitude/analytics-browser", () => ({
  init: sdk.init,
  setOptOut: sdk.optOut,
  add: sdk.add,
  remove: sdk.remove,
  setUserId: sdk.setUserId,
  identify: sdk.identify,
  Identify: class {
    set() {}
  }
}));
vi.mock("@amplitude/plugin-session-replay-browser", () => ({
  sessionReplayPlugin: sdk.replay
}));
vi.mock("react-ga4", () => ({
  default: { initialize: sdk.gaInit, gtag: sdk.gtag }
}));
vi.mock("react-product-fruits", () => ({
  ProductFruits: ({ lifeCycle }: { lifeCycle?: string }) => {
    useEffect(() => {
      sdk.fruitsMount(lifeCycle);
      return () => {
        if (lifeCycle === "unmount") sdk.fruitsUnmount();
      };
    }, [lifeCycle]);
    return <span>Product Fruits fixture</span>;
  }
}));

let AmplitudeProvider: (typeof import("@context/AmplitudeProvider"))["AmplitudeProvider"];
let GoogleTag: (typeof import("@config/GoogleTag"))["GoogleTag"];
let AttributionTracking: (typeof import("@config/AttributionTracking"))["AttributionTracking"];
let ReferralTracking: (typeof import("@config/ReferralTracking"))["ReferralTracking"];
let ProductFruitsProvider: (typeof import("@/providers/ProductFruitsProvider"))["ProductFruitsProvider"];

const GA_DISABLE = "ga-disable-fixture";
const GA_PENDING = "google_analytics_client_id_pending";
const UTM_PENDING = "utm_pending";
const REFERRAL_PENDING = "referral_id_pending";
const accountFixture = () => {
  const lifetime = new AbortController();
  const account = {
    mode: "cloud",
    isCurrent: () => !lifetime.signal.aborted,
    onRetired: (listener: () => void) => {
      if (lifetime.signal.aborted) listener();
      else lifetime.signal.addEventListener("abort", listener, { once: true });
      return () => lifetime.signal.removeEventListener("abort", listener);
    },
    signOut: vi.fn()
  };
  vi.stubGlobal("mago", { account });
  return { account, retire: () => lifetime.abort() };
};

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_AMPLITUDE_API_KEY", "fixture");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_TAG_ID", "fixture");
  vi.stubEnv("NEXT_PUBLIC_PRODUCT_FRUITS_WORKSPACE_CODE", "fixture");
  ({ AmplitudeProvider } = await import("@context/AmplitudeProvider"));
  ({ GoogleTag } = await import("@config/GoogleTag"));
  ({ AttributionTracking } = await import("@config/AttributionTracking"));
  ({ ReferralTracking } = await import("@config/ReferralTracking"));
  ({ ProductFruitsProvider } =
    await import("@/providers/ProductFruitsProvider"));
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sdk.init.mockReturnValue({ promise: Promise.resolve() });
  sdk.add.mockReturnValue({ promise: Promise.resolve() });
  sdk.remove.mockReturnValue({ promise: Promise.resolve() });
  sdk.replay.mockReturnValue({
    name: "replay-fixture",
    teardown: sdk.teardown
  });
  sdk.user.getSessions.mockResolvedValue([]);
  sdk.user.updateMetadata.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, GA_DISABLE);
  vi.useRealTimers();
});

it.each(["success", "failure"])(
  "ignores late Amplitude init %s after opt-out",
  async (result) => {
    const { account, retire } = accountFixture();
    const init = Promise.withResolvers<void>();
    sdk.init.mockReturnValue({ promise: init.promise });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AmplitudeProvider>
        <span>editor</span>
      </AmplitudeProvider>
    );
    act(retire);
    expect(sdk.optOut).toHaveBeenCalledWith(true);
    await act(async () => {
      if (result === "success") init.resolve();
      else init.reject(new Error("stale init"));
    });
    expect(sdk.setUserId).not.toHaveBeenCalled();
    expect(sdk.identify).not.toHaveBeenCalled();
    expect(sdk.add).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(account.signOut).not.toHaveBeenCalled();
  }
);

it.each(["installed", "pending-success", "pending-failure"])(
  "cleans up %s replay without relying on a re-render",
  async (result) => {
    const { retire } = accountFixture();
    const adding = Promise.withResolvers<void>();
    sdk.add.mockReturnValue({ promise: adding.promise });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AmplitudeProvider>
        <span>editor</span>
      </AmplitudeProvider>
    );
    await waitFor(() => expect(sdk.add).toHaveBeenCalledOnce());
    if (result === "installed") await act(async () => adding.resolve());
    act(retire);
    expect(sdk.optOut).toHaveBeenCalledWith(true);
    if (result === "pending-success") await act(async () => adding.resolve());
    if (result === "pending-failure")
      await act(async () => adding.reject(new Error("late replay")));
    if (result === "pending-failure")
      expect(sdk.teardown).toHaveBeenCalledOnce();
    else expect(sdk.remove).toHaveBeenCalledExactlyOnceWith("replay-fixture");
    expect(error).not.toHaveBeenCalled();
  }
);

it("turns off GA and clears its retry timer on retirement", () => {
  vi.useFakeTimers();
  const { retire } = accountFixture();
  render(<GoogleTag />);
  expect(sdk.gaInit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  act(retire);
  expect(Reflect.get(window, GA_DISABLE)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(3000);
  expect(sdk.gtag).not.toHaveBeenCalled();
});

it("does not follow stale GA, attribution and referral callbacks into writes", async () => {
  const { retire } = accountFixture();
  const sessions = Promise.withResolvers<unknown[]>();
  sdk.user.getSessions.mockReturnValue(sessions.promise);
  vi.stubGlobal("gtag", vi.fn());
  const ready = vi.fn();
  vi.stubGlobal("rewardful", ready);
  vi.stubGlobal("Rewardful", { referral: "fixture" });
  localStorage.setItem(UTM_PENDING, JSON.stringify({ utm_source: "fixture" }));
  render(
    <>
      <GoogleTag />
      <AttributionTracking />
      <ReferralTracking />
    </>
  );
  expect(sdk.gtag).toHaveBeenCalledOnce();
  expect(ready).toHaveBeenCalledOnce();
  expect(sdk.user.getSessions).toHaveBeenCalledOnce();
  act(retire);
  // A different live bridge must not revive callbacks from the retired one.
  accountFixture();
  await act(async () => {
    sdk.gtag.mock.calls[0][3]("old-client-id");
    ready.mock.calls[0][1]();
    sessions.resolve([]);
  });
  expect(sdk.user.updateMetadata).not.toHaveBeenCalled();
  expect(localStorage.getItem(GA_PENDING)).toBeNull();
  expect(localStorage.getItem(REFERRAL_PENDING)).toBeNull();
});

it.each(["success", "failure"])(
  "ignores issued metadata write %s settlements after retirement",
  async (result) => {
    const { retire } = accountFixture();
    const pending = Promise.withResolvers<void>();
    sdk.user.updateMetadata.mockReturnValue(pending.promise);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(GA_PENDING, "old-client");
    localStorage.setItem(REFERRAL_PENDING, "old-referral");
    localStorage.setItem(
      UTM_PENDING,
      JSON.stringify({ utm_source: "old-source" })
    );
    render(
      <>
        <GoogleTag />
        <AttributionTracking />
        <ReferralTracking />
      </>
    );
    await waitFor(() =>
      expect(sdk.user.updateMetadata).toHaveBeenCalledTimes(3)
    );
    act(retire);
    localStorage.setItem(GA_PENDING, "new-client");
    localStorage.setItem(REFERRAL_PENDING, "new-referral");
    localStorage.setItem(UTM_PENDING, "new-source");
    await act(async () => {
      if (result === "success") pending.resolve();
      else pending.reject(new Error("stale metadata"));
    });
    expect(localStorage.getItem(GA_PENDING)).toBe("new-client");
    expect(localStorage.getItem(UTM_PENDING)).toBe("new-source");
    expect(localStorage.getItem(REFERRAL_PENDING)).toBe("new-referral");
    expect(error).not.toHaveBeenCalled();
  }
);

it("unmounts desktop Product Fruits in teardown mode, preserving web lifecycle", () => {
  const web = render(<ProductFruitsProvider />);
  expect(sdk.fruitsMount).toHaveBeenLastCalledWith(undefined);
  web.unmount();
  expect(sdk.fruitsUnmount).not.toHaveBeenCalled();
  const { retire } = accountFixture();
  const desktop = render(<ProductFruitsProvider />);
  expect(sdk.fruitsMount).toHaveBeenLastCalledWith("unmount");
  act(retire);
  expect(desktop.queryByText("Product Fruits fixture")).toBeNull();
  expect(sdk.fruitsUnmount).toHaveBeenCalledOnce();
});

it.each(["success", "failure"])(
  "ignores a late %s from the GA client-id callback's metadata write",
  async (outcome) => {
    const { retire } = accountFixture();
    const pending = Promise.withResolvers<void>();
    sdk.user.updateMetadata.mockReturnValueOnce(pending.promise);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("gtag", vi.fn());
    render(<GoogleTag />);
    await act(async () => {
      sdk.gtag.mock.calls[0][3]("old-client");
    });
    expect(sdk.user.updateMetadata).toHaveBeenCalledExactlyOnceWith({
      unsafeMetadata: { google_analytics_user_id: "old-client" }
    });
    act(retire);
    localStorage.setItem(GA_PENDING, "new-client");
    await act(async () => {
      if (outcome === "success") pending.resolve();
      else pending.reject(new Error("stale GA metadata"));
    });
    expect(localStorage.getItem(GA_PENDING)).toBe("new-client");
    expect(error).not.toHaveBeenCalled();
  }
);
