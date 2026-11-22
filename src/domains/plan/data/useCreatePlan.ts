import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { createPlan } from "../api/createPlan";

export const useCreatePlan = () => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: createPlan,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.all });
    }
  });
};
