import { backendApiClient } from "@/lib/backend-api-client";

export const fetchCloudProjectSettings = async (
  projectId: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | undefined> => {
  const response = await backendApiClient.get<{
    settings?: Record<string, unknown> | null;
  }>(`/projects/${projectId}`, { signal });
  return response.data?.settings ?? undefined;
};
