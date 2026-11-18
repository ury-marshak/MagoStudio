import { backendApiClient } from "@/lib/backend-api-client";

import type { CloudApi } from "./mirrorService";

export const backendCloudApi = (): CloudApi => ({
  post: async <T>(
    url: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> =>
    (await backendApiClient.post<T>(url, body ?? {}, { signal })).data,
  get: async <T>(url: string, signal?: AbortSignal): Promise<T> =>
    (await backendApiClient.get<T>(url, { signal })).data
});
