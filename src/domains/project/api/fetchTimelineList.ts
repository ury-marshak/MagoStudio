import { z } from "zod";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import {
  type PaginatedResponse,
  paginatedResponseSchema
} from "@/schemas/pagination";

const timelineListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  total_renders: z.number(),
  total_img2img: z.number(),
  preview_url: z.string().nullable()
});

export type TimelineListItem = z.infer<typeof timelineListItemSchema>;

const timelineListResponseSchema = paginatedResponseSchema(
  timelineListItemSchema
);

const DEFAULT_PER_PAGE = 100;

type TimelineListParams = {
  projectId: string;
  page?: number;
  perPage?: number;
  sortBy?: "created_at" | "updated_at" | "name";
  sortOrder?: "asc" | "desc";
};

export const fetchTimelineList = async (
  {
    projectId,
    page = 1,
    perPage = DEFAULT_PER_PAGE,
    sortBy = "updated_at",
    sortOrder = "desc"
  }: TimelineListParams,
  work?: RendererLibraryWork
): Promise<PaginatedResponse<TimelineListItem>> => {
  const desktop = window.mago;
  if (!desktop) {
    const response = await backendApiClient.get(
      `/projects/${projectId}/timelines/list`,
      {
        params: {
          page,
          per_page: perPage,
          sort_by: sortBy,
          sort_order: sortOrder
        }
      }
    );
    return timelineListResponseSchema.parse(response.data);
  }
  const origin = work ?? rendererLibrary.capture();
  const items = timelineListResponseSchema.shape.items
    .parse(await origin.boundary(() => desktop.projects.listShots(projectId)))
    .sort((left, right) => {
      const direction = sortOrder === "asc" ? 1 : -1;
      return (
        direction * String(left[sortBy]).localeCompare(String(right[sortBy]))
      );
    });
  const offset = (page - 1) * perPage;
  return timelineListResponseSchema.parse({
    items: items.slice(offset, offset + perPage),
    pagination: {
      page,
      per_page: perPage,
      total: items.length,
      pages: Math.ceil(items.length / perPage),
      has_next: offset + perPage < items.length,
      has_prev: page > 1,
      next_num: offset + perPage < items.length ? page + 1 : null,
      prev_num: page > 1 ? page - 1 : null
    }
  });
};
