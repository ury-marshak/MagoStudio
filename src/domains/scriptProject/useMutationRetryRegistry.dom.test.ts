import {
  QueryClient,
  QueryClientProvider,
  useMutation
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  RendererLibrarySession,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { useMutationRetryRegistry } from "./useMutationRetryRegistry";

const renderWithQueryClient = <Result>(hook: () => Result) => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  });
  return renderHook(hook, {
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
  });
};

describe("useMutationRetryRegistry", () => {
  it("replays a failed call with the same request and the caller's own callbacks", async () => {
    const sentRequests: { scriptText: string }[] = [];
    let shouldFail = true;
    const onSuccess = vi.fn();
    const reportedRetries: (() => void)[] = [];

    const { result } = renderWithQueryClient(() => {
      const { findRetryForRequest, withRetryRegistered } =
        useMutationRetryRegistry();
      const castMutation = useMutation({
        mutationFn: async (request: { scriptText: string }) => {
          sentRequests.push(request);
          if (shouldFail) throw new Error("server down");
          return "plan-1";
        },
        onError: (_error, request) => {
          const retry = findRetryForRequest(request);
          if (retry) reportedRetries.push(retry);
        }
      });
      return withRetryRegistered(castMutation);
    });

    const request = { scriptText: "Shot 1:\nA lighthouse." };
    act(() => result.current.mutate(request, { onSuccess }));
    await waitFor(() => expect(reportedRetries).toHaveLength(1));
    expect(onSuccess).not.toHaveBeenCalled();

    shouldFail = false;
    act(() => reportedRetries[0]!());

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(sentRequests).toEqual([request, request]);
    expect(onSuccess.mock.calls[0]![0]).toBe("plan-1");
  });

  it("finds no retry for a request that never went through mutate", () => {
    const { result } = renderWithQueryClient(() => useMutationRetryRegistry());

    expect(
      result.current.findRetryForRequest({ scriptText: "x" })
    ).toBeUndefined();
  });

  it("hands back the same mutate function on every render, so effects that depend on it do not re-run", () => {
    const { result, rerender } = renderWithQueryClient(() => {
      const { withRetryRegistered } = useMutationRetryRegistry();
      return withRetryRegistered(
        useMutation({ mutationFn: async (request: { id: string }) => request })
      );
    });

    const firstMutate = result.current.mutate;
    rerender();

    expect(result.current.mutate).toBe(firstMutate);
  });

  it("registers a retry for a mutateAsync call too", async () => {
    let shouldFail = true;
    const reportedRetries: (() => void)[] = [];

    const { result } = renderWithQueryClient(() => {
      const { findRetryForRequest, withRetryRegistered } =
        useMutationRetryRegistry();
      return withRetryRegistered(
        useMutation({
          mutationFn: async (request: { id: string }) => {
            if (shouldFail) throw new Error("server down");
            return request.id;
          },
          onError: (_error, request) => {
            const retry = findRetryForRequest(request);
            if (retry) reportedRetries.push(retry);
          }
        })
      );
    });

    await act(async () => {
      await result.current.mutateAsync({ id: "shot-2" }).catch(() => undefined);
    });
    expect(reportedRetries).toHaveLength(1);

    shouldFail = false;
    act(() => reportedRetries[0]!());
    await waitFor(() => expect(result.current.data).toBe("shot-2"));
  });
  it("keeps the dispatch origin on retry and ignores old retry buttons after replacement", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const callbacks: (() => void)[] = [];
    const request = { id: "same-sheet" };
    const onSuccess = vi.fn();
    const mutateAsync = vi
      .fn<
        (input: typeof request, origin: RendererLibraryWork) => Promise<string>
      >()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("plan")
      .mockRejectedValueOnce(new Error("failed again"));
    const { result } = renderHook(() => {
      const registry = useMutationRetryRegistry();
      return registry.withLibraryRetryRegistered({
        mutateAsync: async (
          input: typeof request,
          origin: RendererLibraryWork
        ) => {
          try {
            return await mutateAsync(input, origin);
          } catch (error) {
            callbacks.push(registry.findRetryForRequest(input)!);
            throw error;
          }
        }
      });
    });
    await expect(
      result.current.mutateAsync(request, work, onSuccess)
    ).rejects.toThrow("failed");
    callbacks[0]!();
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith("plan")
    );
    expect(mutateAsync).toHaveBeenLastCalledWith(request, work);
    await expect(
      result.current.mutateAsync(request, work, onSuccess)
    ).rejects.toThrow("failed again");
    await library.suspend();
    library.reset();
    callbacks[1]!();
    expect(mutateAsync).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
