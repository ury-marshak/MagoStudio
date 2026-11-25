import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, value: unknown) => Promise<unknown>
  >()
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, value: unknown) => Promise<unknown>
    ) => handlers.set(channel, handler)
  }
}));
vi.mock("./trustedSender", () => ({ requireTrustedSender: () => undefined }));

import { IPC_CHANNELS } from "../../shared/contracts";
import type { CloudProjectMirrorRepository } from "../database/cloudProjectMirrorRepository";
import type { DatabaseManager } from "../database/databaseManager";
import type { ProjectRepository } from "../database/projectRepository";
import type { LibrarySettings } from "../librarySettings";
import { LibraryWorkSession } from "../libraryWorkSession";
import { ProfileIoDrain } from "../providers/profileIoDrain";
import { ProfileLifetime } from "../providers/profileLifetime";

import { registerProjectHandlers } from "./registerProjectHandlers";

describe("tracks:create parent track order validation", () => {
  const createTrack = vi.fn();
  const input = {
    shotId: "shot-1",
    name: "Render",
    type: "RENDER",
    data: {}
  };
  const create = (parentTrackOrder?: unknown) =>
    handlers.get(IPC_CHANNELS.tracksCreate)!(
      {},
      { ...input, parentTrackOrder }
    );

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerProjectHandlers(
      { createTrack } as unknown as ProjectRepository,
      {} as CloudProjectMirrorRepository,
      { isOpen: () => true } as unknown as DatabaseManager,
      {} as LibrarySettings
    );
  });

  it.each([0, 1, 7])(
    "passes the source track order %s to the repository",
    async (parentTrackOrder) => {
      await create(parentTrackOrder);
      expect(createTrack).toHaveBeenCalledWith({ ...input, parentTrackOrder });
    }
  );

  it.each([undefined, null, 1.5, NaN, Infinity, "1"])(
    "rejects invalid parent track order %s",
    async (parentTrackOrder) => {
      await expect(create(parentTrackOrder)).rejects.toThrow(
        "parentTrackOrder must be an integer"
      );
      expect(createTrack).not.toHaveBeenCalled();
    }
  );
});

describe("tracks:update rating validation", () => {
  const updateTrack = vi.fn();
  const input = { trackId: "track-1", name: "Render", data: {} };
  const update = (rating?: unknown) =>
    handlers.get(IPC_CHANNELS.tracksUpdate)!({}, { ...input, rating });

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerProjectHandlers(
      { updateTrack } as unknown as ProjectRepository,
      {} as CloudProjectMirrorRepository,
      { isOpen: () => true } as unknown as DatabaseManager,
      {} as LibrarySettings
    );
  });

  it.each([0, 10, 20, 30])(
    "persists the UI rating %s unchanged",
    async (rating) => {
      await update(rating);
      expect(updateTrack).toHaveBeenCalledWith({ ...input, rating });
    }
  );

  it.each([undefined, null])(
    "allows updates without a rating (%s)",
    async (rating) => {
      await update(rating);
      expect(updateTrack).toHaveBeenCalledWith({ ...input, rating: undefined });
    }
  );

  it.each([-10, 1, 3, 15, 40, 10.5, NaN, Infinity, "10"])(
    "rejects invalid rating %s",
    async (rating) => {
      await expect(update(rating)).rejects.toThrow(
        "rating must be 0, 10, 20, or 30"
      );
      expect(updateTrack).not.toHaveBeenCalled();
    }
  );
});

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

const cloudFixture = () => {
  const profiles = new ProfileLifetime();
  const io = new ProfileIoDrain();
  const capture = vi.fn(() => profiles.capture());
  const getLibraryRoot = vi.fn(async () => "/library");
  const open = vi
    .fn<(root: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const put = vi.fn();
  const cacheAsset = vi.fn();
  const list = vi.fn(async () => []);
  registerProjectHandlers(
    { list } as unknown as ProjectRepository,
    {
      libraryWork: new LibraryWorkSession(() => undefined),
      put,
      cacheAsset
    } as unknown as CloudProjectMirrorRepository,
    { isOpen: () => false, open } as unknown as DatabaseManager,
    {
      getLibraryRoot,
      getAppMode: async () => "cloud"
    } as unknown as LibrarySettings,
    undefined,
    undefined,
    undefined,
    capture,
    undefined,
    io
  );
  return { profiles, io, capture, getLibraryRoot, open, put, cacheAsset, list };
};

it.each([
  IPC_CHANNELS.projectsMirrorCloud,
  IPC_CHANNELS.projectsCacheCloudAsset
])(
  "%s cannot open the DB when the account retires during library lookup",
  async (channel) => {
    const f = cloudFixture();
    const lookingUp = deferred();
    const root = deferred<string>();
    f.getLibraryRoot.mockImplementationOnce(() => {
      lookingUp.resolve();
      return root.promise;
    });
    const stale = expect(handlers.get(channel)!({}, {})).rejects.toThrow();
    await lookingUp.promise;
    f.profiles.suspend();
    await f.io.drainRetired();
    f.profiles.resume();
    root.resolve("/old-library");
    await stale;
    expect(f.open).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
    expect(f.cacheAsset).not.toHaveBeenCalled();
    expect(f.capture).toHaveBeenCalledOnce();
  }
);

it("drains an issued Cloud DB open before retiring the account", async () => {
  const f = cloudFixture();
  const opening = deferred();
  const finishOpen = deferred();
  f.open.mockImplementationOnce(() => {
    opening.resolve();
    return finishOpen.promise;
  });
  const stale = expect(
    handlers.get(IPC_CHANNELS.projectsMirrorCloud)!(
      {},
      { project: { id: "old" } }
    )
  ).rejects.toThrow();
  await opening.promise;
  f.profiles.suspend();
  const drained = vi.fn();
  const drain = f.io.drainRetired().then(drained);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(drained).not.toHaveBeenCalled();
  finishOpen.resolve();
  await drain;
  await stale;
  expect(f.put).not.toHaveBeenCalled();
});

it("can open and list the local DB while account capture is suspended", async () => {
  const f = cloudFixture();
  f.profiles.suspend();
  expect(await handlers.get(IPC_CHANNELS.projectsList)!({}, undefined)).toEqual(
    []
  );
  expect(f.open).toHaveBeenCalledWith("/library");
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.capture).not.toHaveBeenCalled();
});
