"use client";

import axios, { AxiosInstance, isAxiosError } from "axios";

import { isCloudAccountActive } from "@/platform/cloudAccount";

const HTTP_UNAUTHORIZED = 401;

export const API_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3000";

const backendApiClient: AxiosInstance = axios.create({
  baseURL: API_URL
});

let getTokenFunction: (() => Promise<string | null>) | null = null;

let apiKey: string | null = null;
let requestInterceptorId: number | null = null;
let apiKeyReadyPromise: Promise<void> | null = null;
let resolveApiKeyReady: (() => void) | null = null;
let rejectApiKeyReady: ((reason: unknown) => void) | null = null;

const ensureApiKeyReadiness = (): void => {
  if (apiKey || apiKeyReadyPromise) return;
  apiKeyReadyPromise = new Promise<void>((resolve, reject) => {
    resolveApiKeyReady = resolve;
    rejectApiKeyReady = reject;
  });
  // The provider reports initialization failures through navigation. This catch prevents an
  // unhandled rejection when no cloud request happened to be waiting at the same time.
  void apiKeyReadyPromise.catch(() => undefined);
};

const requireCloudAccount = (): void => {
  if (!isCloudAccountActive())
    throw new Error(
      "Mago Cloud requests require an explicitly selected cloud account. Local projects remain available without signing in."
    );
};

const ensureRequestInterceptor = (): void => {
  if (requestInterceptorId !== null) return;
  requestInterceptorId = backendApiClient.interceptors.request.use(
    async (config) => {
      // Install this independently of BackendApiProvider: an accidental API
      // call must fail before credentials, a never-resolved key barrier or I/O.
      const checkDispatch = () => {
        if (config.signal?.aborted) throw new axios.CanceledError();
        requireCloudAccount();
      };
      checkDispatch();
      if (apiKeyReadyPromise) await apiKeyReadyPromise;
      checkDispatch();

      if (getTokenFunction) {
        try {
          const token = await getTokenFunction();
          if (token) config.headers.Authorization = `Bearer ${token}`;
        } catch (error) {
          console.error("Failed to get auth token:", error);
        }
      }

      // Account choice normally rebuilds the window. Still refuse continuations
      // already waiting for credentials if the bridge has since changed.
      checkDispatch();
      if (apiKey) config.headers["X-API-Key"] = apiKey;
      return config;
    },
    (error) => Promise.reject(error)
  );
};

ensureRequestInterceptor();

export function initializeBackendApiClient(
  getToken: (options?: { template?: string }) => Promise<string | null>,
  options: { waitForApiKey?: boolean } = {}
) {
  getTokenFunction = () => getToken({ template: "basicToken" });
  ensureRequestInterceptor();
  if (options.waitForApiKey) ensureApiKeyReadiness();
}

export function setApiKey(key: string) {
  apiKey = key;
  resolveApiKeyReady?.();
  resolveApiKeyReady = null;
  rejectApiKeyReady = null;
}

export function rejectApiKeyInitialization(reason: unknown) {
  rejectApiKeyReady?.(reason);
  resolveApiKeyReady = null;
  rejectApiKeyReady = null;
}

let unauthorizedResponseInterceptorId: number | null = null;

export function registerUnauthorizedHandler(onUnauthorized: () => void) {
  if (unauthorizedResponseInterceptorId !== null) {
    backendApiClient.interceptors.response.eject(
      unauthorizedResponseInterceptorId
    );
  }

  unauthorizedResponseInterceptorId =
    backendApiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (
          isAxiosError(error) &&
          error.response?.status === HTTP_UNAUTHORIZED
        ) {
          onUnauthorized();
        }
        return Promise.reject(error);
      }
    );
}

export { backendApiClient };
