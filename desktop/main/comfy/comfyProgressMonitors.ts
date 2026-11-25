import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";

import { COMFY_PROCESS_CLIENT_ID } from "./comfyClientId";
import {
  type ComfyWebSocket,
  ComfyProgressMonitor
} from "./ComfyProgressMonitor";
import { normalizeComfyEndpoint } from "./normalizeComfyEndpoint";

type Scope = { clientId: string; monitors: Map<string, ComfyProgressMonitor> };
type SettleListener = (promptId: string, profile?: AbortSignal) => void;
const unscoped: Scope = {
  clientId: COMFY_PROCESS_CLIENT_ID,
  monitors: new Map()
};
const scopes = new WeakMap<AbortSignal, Scope>();
const activeScopes = new Set<Scope>([unscoped]);
const promptSettledListeners = new Set<SettleListener>();

const clearScope = (scope: Scope): void => {
  for (const monitor of scope.monitors.values()) monitor.close();
  scope.monitors.clear();
};

const scopeFor = (profile?: AbortSignal): Scope => {
  if (!profile) return unscoped;
  profile.throwIfAborted();
  const existing = scopes.get(profile);
  if (existing) return existing;
  const scope: Scope = { clientId: randomUUID(), monitors: new Map() };
  scopes.set(profile, scope);
  activeScopes.add(scope);
  addAbortListener(profile, () => {
    clearScope(scope);
    activeScopes.delete(scope);
  });
  return scope;
};

const createNativeWebSocket = (url: string): ComfyWebSocket =>
  new WebSocket(url);

export const comfyProgressMonitorFor = (
  endpoint: string,
  profile?: AbortSignal
): ComfyProgressMonitor => {
  const { clientId, monitors: monitorsByEndpoint } = scopeFor(profile);
  const normalizedEndpoint = normalizeComfyEndpoint(endpoint);
  const existingMonitor = monitorsByEndpoint.get(normalizedEndpoint);
  if (existingMonitor) return existingMonitor;
  const monitor = new ComfyProgressMonitor(
    normalizedEndpoint,
    clientId,
    createNativeWebSocket
  );
  monitor.onPromptSettled((promptId) => {
    for (const listener of promptSettledListeners) {
      if (profile?.aborted) return;
      listener(promptId, profile);
    }
  });
  monitorsByEndpoint.set(normalizedEndpoint, monitor);
  return monitor;
};

export const onAnyComfyPromptSettled = (
  listener: SettleListener
): (() => void) => {
  promptSettledListeners.add(listener);
  return () => promptSettledListeners.delete(listener);
};

export const closeAllComfyProgressMonitors = (): void => {
  for (const scope of activeScopes) clearScope(scope);
};
