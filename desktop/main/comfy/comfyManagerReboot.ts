const COMFY_MANAGER_ROUTE_PREFIXES = ["/api/manager", "/manager"];
const COMFY_MANAGER_TIMEOUT_MS = 3_000;

const requestComfyManager = async (
  endpoint: string,
  route: string,
  signal?: AbortSignal
) => {
  for (const prefix of COMFY_MANAGER_ROUTE_PREFIXES) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(COMFY_MANAGER_TIMEOUT_MS);
    const response = await fetch(`${endpoint}${prefix}${route}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    }).catch(() => null);
    void response?.body?.cancel().catch(() => {});
    signal?.throwIfAborted();
    if (response?.ok) return true;
  }
  return false;
};

export const isComfyManagerAvailable = (
  endpoint: string,
  signal?: AbortSignal
) => requestComfyManager(endpoint, "/version", signal);

export const rebootThroughComfyManager = (
  endpoint: string,
  signal?: AbortSignal
) => requestComfyManager(endpoint, "/reboot", signal);
