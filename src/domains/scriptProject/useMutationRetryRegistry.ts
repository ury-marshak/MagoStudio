import { MutateOptions, UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

type MutationCalls<Data, MutationError, Request, Context> = {
  mutate: (
    request: Request,
    callOptions?: MutateOptions<Data, MutationError, Request, Context>
  ) => void;
  mutateAsync: (
    request: Request,
    callOptions?: MutateOptions<Data, MutationError, Request, Context>
  ) => Promise<Data>;
};

export const useMutationRetryRegistry = () => {
  const [retryByRequest] = useState(() => new WeakMap<object, () => void>());
  const [registeredCallsByMutate] = useState(
    () => new WeakMap<object, unknown>()
  );

  const buildRegisteredCalls = <
    Data,
    MutationError,
    Request extends object,
    Context
  >(
    mutation: UseMutationResult<Data, MutationError, Request, Context>
  ): MutationCalls<Data, MutationError, Request, Context> => {
    const { mutate: originalMutate, mutateAsync: originalMutateAsync } =
      mutation;
    return {
      mutate: (request, callOptions) => {
        const retry = () => originalMutate(request, callOptions);
        retryByRequest.set(request, retry);
        retry();
      },
      mutateAsync: (request, callOptions) => {
        retryByRequest.set(request, () => originalMutate(request, callOptions));
        return originalMutateAsync(request, callOptions);
      }
    };
  };

  return {
    findRetryForRequest: (request: object) => retryByRequest.get(request),
    withLibraryRetryRegistered: <
      Data,
      Request extends object,
      Mutation extends {
        mutateAsync(request: Request, work: RendererLibraryWork): Promise<Data>;
      }
    >(
      mutation: Mutation & {
        mutateAsync(request: Request, work: RendererLibraryWork): Promise<Data>;
      }
    ) => {
      const mutateAsync = (
        request: Request,
        work = rendererLibrary.capture(),
        onSuccess?: (data: Data) => void
      ): Promise<Data> => {
        // Each dispatch gets its own retry, even if the caller reuses a payload.
        const input = { ...request };
        const run = async () => {
          work.check();
          const result = await mutation.mutateAsync(input, work);
          work.check();
          onSuccess?.(result);
          return result;
        };
        retryByRequest.set(input, () => {
          if (!work.signal.aborted) void run().catch(() => {});
        });
        return run();
      };
      return {
        ...mutation,
        mutateAsync,
        mutate: (
          request: Request,
          work?: RendererLibraryWork,
          onSuccess?: (data: Data) => void,
          onSettled?: () => void
        ) => {
          const origin = work ?? rendererLibrary.capture();
          void mutateAsync(request, origin, onSuccess)
            .catch(() => {})
            .finally(() => {
              if (!origin.signal.aborted) onSettled?.();
            });
        }
      };
    },
    withRetryRegistered: <Data, MutationError, Request extends object, Context>(
      mutation: UseMutationResult<Data, MutationError, Request, Context>
    ) => {
      const registeredCalls =
        (registeredCallsByMutate.get(mutation.mutate) as
          | MutationCalls<Data, MutationError, Request, Context>
          | undefined) ?? buildRegisteredCalls(mutation);
      registeredCallsByMutate.set(mutation.mutate, registeredCalls);

      return { ...mutation, ...registeredCalls };
    }
  };
};
