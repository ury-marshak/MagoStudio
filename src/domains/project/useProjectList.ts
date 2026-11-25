import { ProjectType } from "@schemas/scriptProject";
import {
  type FetchNextPageOptions,
  useInfiniteQuery
} from "@tanstack/react-query";
import { useCallback } from "react";

import { isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

export type { ProjectListItem } from "./api/fetchProjectList";

import {
  DEFAULT_PER_PAGE,
  type ProjectListItem,
  fetchProjectList
} from "./api/fetchProjectList";
import { keepProjectsOfType } from "./utils/keepProjectsOfType";

const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const STALE_TIME_MINUTES = 5;
const STALE_TIME_MS =
  STALE_TIME_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

type UseProjectListParams = {
  perPage?: number;
  sortBy?: "updated_at" | "name";
  sortOrder?: "asc" | "desc";
  projectType?: ProjectType;
  enabled?: boolean;
};

export const useProjectList = ({
  perPage = DEFAULT_PER_PAGE,
  sortBy = "updated_at",
  sortOrder = "desc",
  projectType,
  enabled = true
}: UseProjectListParams = {}) => {
  const scope = useRendererLibraryQueryScope();
  const queryKey = scope.key(
    queryKeys.projectList.paginated({
      perPage,
      sortBy,
      sortOrder,
      projectType
    })
  );
  const query = useInfiniteQuery({
    queryKey,
    retry: scope.retry(queryKey),
    queryFn: ({ pageParam }) =>
      scope.run(() =>
        fetchProjectList(
          {
            page: pageParam,
            perPage,
            sortBy,
            sortOrder,
            projectType
          },
          scope.work
        )
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.has_next ? lastPage.pagination.next_num : undefined,
    staleTime: STALE_TIME_MS,
    enabled: enabled && scope.active,
    refetchOnMount: isLocalApp ? "always" : true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true
  });
  const { fetchNextPage } = query;
  const { work } = scope;
  const fetchNextLibraryPage = useCallback(
    async (options?: FetchNextPageOptions) => {
      if (work.signal.aborted) return undefined;
      const result = await fetchNextPage(options);
      return work.signal.aborted ? undefined : result;
    },
    [fetchNextPage, work]
  );
  const allItems: ProjectListItem[] = keepProjectsOfType(
    query.data?.pages.flatMap((page) => page.items) ?? [],
    projectType
  );
  const totalCount = query.data?.pages[0]?.pagination.total ?? 0;

  return {
    ...query,
    fetchNextPage: fetchNextLibraryPage,
    allItems,
    totalCount
  };
};
