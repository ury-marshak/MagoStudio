// A renderer account window never joins a replacement profile, even when the
// same mode is selected again. The bridge's mode is only the boot-time choice.
type AccountBridge = Window["mago"]["account"];
const lifetimes = new WeakMap<AccountBridge, AbortController>();

export const captureRendererAccountProfile = (): AbortSignal | undefined => {
  const account =
    typeof window === "undefined" ? undefined : window.mago?.account;
  // The web and partial renderer test fixtures have no desktop lifetime bridge.
  if (!account?.onRetired || !account.isCurrent) return;

  let lifetime = lifetimes.get(account);
  if (!lifetime) {
    const controller = new AbortController();
    const unsubscribe = account.onRetired(() => controller.abort());
    controller.signal.addEventListener("abort", unsubscribe, { once: true });
    lifetimes.set(account, controller);
    lifetime = controller;
  }
  if (!lifetime.signal.aborted) {
    try {
      if (!account.isCurrent()) lifetime.abort();
    } catch {
      lifetime.abort();
    }
  }
  return lifetime.signal;
};

export const isRendererAccountProfileRetired = (): boolean =>
  captureRendererAccountProfile()?.aborted ?? false;
