const INVENTORY_TIMEOUT_MS = 5_000;

export const readSetupInventory = async (
  url: string,
  signal?: AbortSignal
): Promise<unknown> => {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(INVENTORY_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const response = await fetch(url, { signal: requestSignal });
  if (!response.ok || requestSignal.aborted) {
    await response.body?.cancel().catch(() => {});
    requestSignal.throwIfAborted();
    throw new Error(`ComfyUI inventory request failed (${response.status})`);
  }
  const value: unknown = await response.json();
  requestSignal.throwIfAborted();
  return value;
};
