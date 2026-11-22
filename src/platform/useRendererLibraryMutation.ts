import { useMutation } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import {
  rendererLibrary,
  type RendererLibraryWork
} from "./rendererLibraryWork";

type LibraryMutationOptions<Data, Input, Optimistic> = {
  mutationFn(input: Input, work: RendererLibraryWork): Promise<Data>;
  onMutate?(
    input: Input,
    work: RendererLibraryWork
  ): Optimistic | Promise<Optimistic>;
  onSuccess?(data: Data, input: Input): void;
  onError?(error: Error, input: Input, context: Optimistic | undefined): void;
};

/** Bind the action at dispatch, not inside React Query's queued mutationFn.
 * Keep its options too: an observer can rerender with new selection while a
 * mutation is pending. Neither new settings nor reused IDs retarget that action. */
export function useRendererLibraryMutation<Data, Input, Optimistic = unknown>(
  options: LibraryMutationOptions<Data, Input, Optimistic>
) {
  // An abort-ignoring request may outlive replacement; its observer must not
  // keep the replacement form busy. Do not connect the bridge until dispatch.
  useSyncExternalStore(
    rendererLibrary.subscribe,
    rendererLibrary.getSnapshot,
    rendererLibrary.getSnapshot
  );
  type Action = {
    input: Input;
    work: RendererLibraryWork;
    options: typeof options;
  };
  const mutation = useMutation({
    mutationFn: async ({ input, work, options }: Action) => {
      await work.ready();
      work.check();
      const data = await options.mutationFn(input, work);
      work.check();
      return data;
    },
    onMutate: async ({ input, work, options }) => {
      if (!options.onMutate) return;
      await work.ready();
      work.check();
      return options.onMutate(input, work);
    },
    onSuccess: (data, { input, work, options }) => {
      work.check();
      options.onSuccess?.(data, input);
    },
    onError: (error, { input, work, options }, context) => {
      if (!work.signal.aborted) options.onError?.(error, input, context);
    }
  });

  return {
    ...mutation,
    isPending: mutation.isPending && !mutation.variables?.work.signal.aborted,
    variables: mutation.variables?.input,
    mutate: (input: Input, work = rendererLibrary.capture()) =>
      mutation.mutate({ input, work, options }),
    mutateAsync: async (input: Input, work = rendererLibrary.capture()) => {
      try {
        const data = await mutation.mutateAsync({ input, work, options });
        work.check();
        return data;
      } catch (error) {
        work.check();
        throw error;
      }
    }
  };
}
