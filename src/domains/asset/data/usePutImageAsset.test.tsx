import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { putImageAsset } from "../api/putImageAsset";

import { usePutImageAsset } from "./usePutImageAsset";

const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock("@/lib/backend-api-client", () => ({ backendApiClient: { put } }));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => window.mago
}));

const assetId = "reused-id";
const bridge = (cloudMirror: boolean, initialRating: number) => {
  let rating = initialRating;
  const asset = () => ({
    id: assetId,
    filepath: "mago-media://asset/reused-id",
    data: { cloudMirror, rate: rating }
  });
  const assets = {
    get: vi.fn(async () => asset()),
    update: vi.fn(async ({ rate }: { rate: number }) => {
      rating = rate;
      return asset();
    })
  };
  vi.stubGlobal("mago", {
    assets,
    library: { onWillChange: async () => {}, onDidChange: () => {} }
  });
  return { assets, asset };
};

afterEach(async () => {
  await rendererLibrary.suspend();
  rendererLibrary.reset();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("does not apply or invalidate a delayed cloud rating in a replacement with the same asset ID", async () => {
  const a = bridge(true, 0);
  const cloud = Promise.withResolvers<{ data: unknown }>();
  put.mockReturnValueOnce(cloud.promise);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => usePutImageAsset({ assetId }), {
    wrapper
  });
  const oldAction = result.current.mutate;
  let pending!: Promise<unknown>;
  act(() => {
    pending = result.current
      .mutateAsync({ rate: 2 })
      .catch((error: unknown) => error);
  });
  await waitFor(() => expect(put).toHaveBeenCalledOnce());
  const signal = put.mock.calls[0]?.[2].signal;
  let b!: ReturnType<typeof bridge>;
  await act(async () => {
    await rendererLibrary.suspend();
    b = bridge(false, 1);
    rendererLibrary.reset();
  });
  const key = queryKeys.imageAsset.byId(assetId);
  client.setQueryData(key, b.asset());
  expect(result.current.isPending).toBe(false);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    cloud.resolve({ data: { rate: 2 } });
    expect(await pending).toMatchObject({ name: "AbortError" });
    oldAction({ rate: 2 });
  });
  expect(a.assets.update).not.toHaveBeenCalled();
  expect(b.assets.get).not.toHaveBeenCalled();
  expect(b.assets.update).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  expect(client.getQueryData(key)).toMatchObject({ data: { rate: 1 } });

  await act(async () => {
    await result.current.mutateAsync({ rate: 0 });
  });
  expect(b.asset().data.rate).toBe(0);
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: key });
});

it("drains an issued local rating update before allowing a library replacement", async () => {
  const a = bridge(false, 0);
  const update = Promise.withResolvers<ReturnType<typeof a.asset>>();
  a.assets.update.mockReturnValueOnce(update.promise);
  const request = putImageAsset(assetId, { rate: 2 });
  const stopped = expect(request).rejects.toMatchObject({ name: "AbortError" });
  await waitFor(() => expect(a.assets.update).toHaveBeenCalledOnce());
  const drained = vi.fn();
  const suspend = rendererLibrary.suspend().then(drained);
  await Promise.resolve();
  expect(drained).not.toHaveBeenCalled();
  update.resolve(a.asset());
  await suspend;
  await stopped;
  expect(put).not.toHaveBeenCalled();
});
