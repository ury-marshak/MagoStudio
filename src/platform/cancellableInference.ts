import { getLocalDesktopApi } from "./localDesktop";

/** AbortSignal stays in the renderer; only its opaque request ID crosses IPC. */
export const cancellableInference = async <T>(
  invoke: (requestId?: string) => Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  if (!signal) return invoke();
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => {
    void getLocalDesktopApi()
      .vlm.cancel(id)
      .catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invoke(id);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};
