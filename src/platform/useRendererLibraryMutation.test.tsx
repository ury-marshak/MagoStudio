import {
  MutationCache,
  QueryClient,
  QueryClientProvider
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { type PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "./rendererLibraryWork";
import { useRendererLibraryMutation } from "./useRendererLibraryMutation";

const deferred = () => {
  let release!: () => void;
  const result = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { result, release };
};

const switchLibrary = async () => {
  await rendererLibrary.suspend();
  rendererLibrary.reset();
};

afterEach(switchLibrary);

const setup = (mutationCache = new MutationCache()) => {
  const client = new QueryClient({ mutationCache });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

it("binds origin before React Query's asynchronous onMutate and refuses a queued old action", async () => {
  const held = deferred();
  const onMutate = vi.fn(() => held.result);
  const oldAction = vi.fn(async (id: string) => id);
  const replacement = vi.fn(async (id: string) => id);
  const onError = vi.fn();
  const { wrapper } = setup();
  const { result, rerender } = renderHook(
    ({ mutationFn }) =>
      useRendererLibraryMutation({ mutationFn, onMutate, onError }),
    { wrapper, initialProps: { mutationFn: oldAction } }
  );
  const stale = result.current
    .mutateAsync("reused")
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(onMutate).toHaveBeenCalledOnce());
  await switchLibrary();
  rerender({ mutationFn: replacement });
  held.release();
  expect(await stale).toMatchObject({ name: "AbortError" });
  expect(oldAction).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  await act(async () => {
    await expect(result.current.mutateAsync("reused")).resolves.toBe("reused");
  });
  expect(replacement).toHaveBeenCalledOnce();
});

it("keeps success and invalidation tied to the original selection during navigation", async () => {
  const held = deferred();
  const start = vi.fn(async () => held.result);
  const { client, wrapper } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const { result, rerender } = renderHook(
    ({ projectId }) =>
      useRendererLibraryMutation({
        mutationFn: async (name: string) => {
          await start();
          return name;
        },
        onSuccess: (name) => {
          client.setQueryData(["project", projectId], name);
          void client.invalidateQueries({ queryKey: ["project", projectId] });
        }
      }),
    { wrapper, initialProps: { projectId: "original" } }
  );
  const renamed = result.current.mutateAsync("renamed");
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  rerender({ projectId: "navigated" });
  held.release();
  await renamed;
  expect(client.getQueryData(["project", "original"])).toBe("renamed");
  expect(client.getQueryData(["project", "navigated"])).toBeUndefined();
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({
    queryKey: ["project", "original"]
  });
});

it("refuses a delayed success callback after reset without invalidating or rolling back a replacement query", async () => {
  const held = deferred();
  const globalSuccess = vi.fn(() => held.result);
  const { client, wrapper } = setup(
    new MutationCache({ onSuccess: globalSuccess })
  );
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const rollback = vi.fn();
  const { result } = renderHook(
    () =>
      useRendererLibraryMutation({
        mutationFn: async (id: string) => id,
        onSuccess: (id) => {
          client.setQueryData(["project", id], "old");
          void client.invalidateQueries({ queryKey: ["project", id] });
        },
        onError: rollback
      }),
    { wrapper }
  );
  const stale = result.current
    .mutateAsync("reused")
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(globalSuccess).toHaveBeenCalledOnce());
  await switchLibrary();
  client.setQueryData(["project", "reused"], "replacement");
  held.release();
  expect(await stale).toMatchObject({ name: "AbortError" });
  expect(client.getQueryData(["project", "reused"])).toBe("replacement");
  expect(invalidate).not.toHaveBeenCalled();
  expect(rollback).not.toHaveBeenCalled();
});
