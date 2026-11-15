import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settle: vi.fn(),
  forget: vi.fn(),
  reset: vi.fn()
}));
vi.mock("electron", () => {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 32, height: 24 }),
    toPNG: () => Buffer.from("png"),
    toJPEG: () => Buffer.from("jpg"),
    resize: () => image
  };
  return {
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    nativeImage: { createFromPath: () => image, createFromBuffer: () => image }
  };
});
vi.mock("../comfy/comfyProgressMonitors", () => ({
  onAnyComfyPromptSettled: mocks.settle,
  comfyProgressMonitorFor: () => ({
    livePrompt: () => null,
    forget: mocks.forget,
    resetConnection: mocks.reset,
    watch: vi.fn()
  })
}));
vi.mock("../media/runLibraryFfmpeg", async (original) => {
  const actual = await original<typeof import("../media/runLibraryFfmpeg")>();
  return { ...actual, runLibraryFfmpeg: vi.fn(actual.runLibraryFfmpeg) };
});
vi.mock("../storage/atomicFile", async (original) => {
  const actual = await original<typeof import("../storage/atomicFile")>();
  return { ...actual, atomicWriteFile: vi.fn(actual.atomicWriteFile) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readFile: vi.fn(actual.readFile)
  };
});

import { CloudRenderSubmitService } from "../cloud/cloudRenderSubmitService";
import { DatabaseManager } from "../database/databaseManager";
import {
  assets,
  clips,
  cloudRenderJobs,
  imageRenderJobs,
  projects,
  shots,
  tracks
} from "../database/schema";
import { clearLibraryIssues, listLibraryIssues } from "../libraryHealth";
import { runLibraryFfmpeg } from "../media/runLibraryFfmpeg";
import { atomicWriteFile } from "../storage/atomicFile";

import { ComfyQwenClient } from "./comfyQwenClient";
import { ImageRenderService } from "./imageRenderService";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const roots: string[] = [];
const managers: DatabaseManager[] = [];
const owners: Array<{ suspend: () => Promise<void> }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  clearLibraryIssues();
  mocks.settle.mockReturnValue(vi.fn());
  vi.spyOn(ComfyQwenClient.prototype, "poll").mockResolvedValue({
    state: "queued"
  });
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.suspend()));
  managers.splice(0).forEach((manager) => manager.close());
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const request = {
  projectId: "p",
  shotId: "s",
  sourceAssetId: "a",
  inputImageId: "a",
  model: "qwen" as const,
  name: "render",
  frame: 0,
  referenceImageIds: [],
  settings: {},
  comfyEndpoint: "http://fixture.invalid"
};
const registration = {
  outputTrackId: "t",
  sourceAssetId: "a",
  model: "v8.0.0",
  frameRange: [0, 23] as [number, number],
  fps: 24,
  cloudAssetId: "cloud",
  settings: {}
};
const imageRegistration = {
  ...request,
  cloudAssetId: "cloud",
  cloudClipId: "cloud-clip"
};
const fixture = async () => {
  const pair = await Promise.all(
    [0, 1].map(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "mago-legacy-owner-"));
      roots.push(root);
      const manager = new DatabaseManager();
      managers.push(manager);
      await manager.open(root);
      const now = new Date();
      await manager
        .get()
        .insert(projects)
        .values({ id: "p", name: "project", createdAt: now, updatedAt: now });
      await manager.get().insert(shots).values({
        id: "s",
        projectId: "p",
        name: "shot",
        createdAt: now,
        updatedAt: now
      });
      await manager.get().insert(tracks).values({
        id: "t",
        projectId: "p",
        shotId: "s",
        name: "track",
        type: "RENDER",
        createdAt: now,
        updatedAt: now
      });
      await writeFile(path.join(root, "saved.png"), "historical cached output");
      await manager
        .get()
        .insert(assets)
        .values({
          id: "a",
          name: "asset",
          type: "image",
          origin: "generated",
          status: "INQUEUE",
          sourcePath: path.join(root, "saved.png"),
          dataJson: JSON.stringify({
            url: "https://historical.invalid/image.png"
          }),
          createdAt: now,
          updatedAt: now
        });
      await manager.get().insert(clips).values({
        id: "c",
        trackId: "t",
        assetId: "a",
        name: "clip",
        createdAt: now,
        updatedAt: now
      });
      await manager
        .get()
        .insert(imageRenderJobs)
        .values({
          id: "j",
          model: "qwen",
          projectId: "p",
          shotId: "s",
          trackId: "t",
          clipId: "c",
          assetId: "a",
          status: "INQUEUE",
          providerRequestId: "accepted",
          requestJson: JSON.stringify(request),
          createdAt: now,
          updatedAt: now
        });
      await manager
        .get()
        .insert(cloudRenderJobs)
        .values({
          id: "j",
          model: "v8.0.0",
          cloudAssetId: "cloud",
          projectId: "p",
          shotId: "s",
          trackId: "t",
          clipId: "c",
          assetId: "a",
          status: "PENDING",
          requestJson: JSON.stringify({ kind: "img2img", settings: {} }),
          createdAt: now,
          updatedAt: now
        });
      manager.close();
      return root;
    })
  );
  const manager = new DatabaseManager();
  managers.push(manager);
  let root = pair[0]!;
  await manager.open(root);
  const getRoot = vi.fn(async () => root);
  const available = vi.fn();
  const policy = vi.fn(async () => {});
  const local = new ImageRenderService(
    manager,
    getRoot,
    async () => "http://fixture.invalid",
    available,
    policy
  );
  const cloud = new CloudRenderSubmitService(manager, getRoot, available);
  owners.push(local, cloud.libraryWork);
  const switchLibrary = async () => {
    await Promise.all([local.suspend(), cloud.libraryWork.suspend()]);
    root = pair[1]!;
    await manager.open(root);
    // Avoid starting background inference in the fixture; timer starts have their own test.
    local.libraryWork.reset();
    cloud.libraryWork.reset();
  };
  const assertReplacement = async () => {
    const [asset] = await manager
      .get()
      .select()
      .from(assets)
      .where(eq(assets.id, "a"));
    expect(asset?.status).toBe("INQUEUE");
    expect(JSON.parse(asset!.dataJson!)).toEqual({
      url: "https://historical.invalid/image.png"
    });
    expect(await readFile(path.join(pair[1]!, "saved.png"), "utf8")).toBe(
      "historical cached output"
    );
    expect(
      (await manager.get().select().from(imageRenderJobs))[0]!.status
    ).toBe("INQUEUE");
    expect(
      (await manager.get().select().from(cloudRenderJobs))[0]!.status
    ).toBe("PENDING");
    expect(available).not.toHaveBeenCalled();
    expect(listLibraryIssues()).toEqual([]);
  };
  return {
    manager,
    pair,
    local,
    cloud,
    getRoot,
    policy,
    available,
    switchLibrary,
    assertReplacement
  };
};

describe("legacy render library ownership", () => {
  it.each(["kick", "reconcileInterruptedRenders", "submit"] as const)(
    "captures %s before a delayed policy check without draining inference",
    async (method) => {
      const f = await fixture();
      const gate = deferred();
      f.policy.mockImplementationOnce(() => gate.promise);
      const pending =
        method === "submit" ? f.local.submit(request) : f.local[method]();
      const rejected = expect(pending).rejects.toThrow();
      await f.switchLibrary();
      gate.resolve();
      await rejected;
      expect(f.getRoot).not.toHaveBeenCalled();
      await f.assertReplacement();
    }
  );

  it.each(["finished", "error", "running"] as const)(
    "ignores an abort-ignoring late %s provider result with reused IDs",
    async (state) => {
      const f = await fixture();
      const gate = deferred<Awaited<ReturnType<ComfyQwenClient["poll"]>>>();
      const poll = vi
        .spyOn(ComfyQwenClient.prototype, "poll")
        .mockImplementationOnce(() => gate.promise);
      const cancel = vi
        .spyOn(ComfyQwenClient.prototype, "cancel")
        .mockResolvedValue();
      const submit = vi
        .spyOn(ComfyQwenClient.prototype, "submit")
        .mockRejectedValue(new Error("must not resubmit"));
      const pending = f.local.kick();
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
      await f.switchLibrary();
      gate.resolve(
        state === "finished"
          ? { state, bytes: Buffer.from("late image") }
          : state === "error"
            ? { state, message: "late failure" }
            : { state }
      );
      await rejected;
      await f.assertReplacement();
      expect(cancel).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(mocks.forget).not.toHaveBeenCalled();
      expect(mocks.reset).not.toHaveBeenCalled();
    }
  );

  it("old finally/queued-kick cleanup cannot release replacement processing state", async () => {
    const f = await fixture();
    const old = deferred<Awaited<ReturnType<ComfyQwenClient["poll"]>>>(),
      current = deferred<Awaited<ReturnType<ComfyQwenClient["poll"]>>>();
    const poll = vi
      .spyOn(ComfyQwenClient.prototype, "poll")
      .mockResolvedValue({ state: "queued" })
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => current.promise);
    const first = f.local.kick();
    const firstRejected = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    await f.local.kick();
    await f.switchLibrary();
    const second = f.local.kick();
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(2));
    old.resolve({ state: "error", message: "old" });
    await firstRejected;
    await f.local.kick();
    expect(poll).toHaveBeenCalledTimes(2);
    current.resolve({ state: "queued" });
    await second;
    await f.assertReplacement();
  });

  it("retains timer and global-settle callback ownership even when emitted in a new session", async () => {
    const f = await fixture();
    f.local.start();
    await flush();
    const oldSettle = mocks.settle.mock.calls.at(-1)![0] as () => void;
    await f.switchLibrary();
    f.policy.mockClear();
    oldSettle();
    await flush();
    expect(f.policy).not.toHaveBeenCalled();
    f.local.start();
    await flush();
    expect(f.policy).toHaveBeenCalled();
  });

  it.each(["stat", "read"] as const)(
    "drains an issued recovery %s before replacement, without stale health/status writes",
    async (kind) => {
      const f = await fixture();
      const gate = deferred<unknown>();
      const entered = deferred();
      if (kind === "stat")
        vi.mocked(stat).mockImplementationOnce(() => {
          entered.resolve();
          return gate.promise as ReturnType<typeof stat>;
        });
      else
        vi.mocked(readFile).mockImplementationOnce(() => {
          entered.resolve();
          return gate.promise as ReturnType<typeof readFile>;
        });
      const pending = f.local.reconcileInterruptedRenders();
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      let switched = false;
      const switching = f.switchLibrary().then(() => {
        switched = true;
      });
      await flush();
      expect(switched).toBe(false);
      gate.resolve(
        kind === "stat"
          ? { isFile: () => true, size: 5 }
          : Buffer.from("old image")
      );
      await switching;
      await rejected;
      await f.assertReplacement();
    }
  );

  it("drains every issued image write, including late siblings after Promise.all rejects", async () => {
    const f = await fixture();
    const job = (await f.manager.get().select().from(imageRenderJobs))[0]!;
    const gates = [deferred(), deferred()];
    const entered = deferred();
    let count = 0;
    vi.mocked(atomicWriteFile)
      .mockImplementationOnce(async () => {
        if (++count === 2) entered.resolve();
        await gates[0]!.promise;
        throw new Error("old write failure");
      })
      .mockImplementationOnce(async () => {
        if (++count === 2) entered.resolve();
        await gates[1]!.promise;
      });
    const pending = (
      f.local as unknown as {
        completeImageBytes: (
          job: typeof imageRenderJobs.$inferSelect,
          bytes: Buffer,
          provider: string
        ) => Promise<void>;
      }
    ).completeImageBytes(job, Buffer.from("image"), "fixture");
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    let switched = false;
    const switching = f.switchLibrary().then(() => {
      switched = true;
    });
    gates[0]!.resolve();
    await rejected;
    await flush();
    expect(switched).toBe(false);
    gates[1]!.resolve();
    await switching;
    await f.assertReplacement();
  });

  it.each(["local", "cloud"] as const)(
    "drains an already-issued %s transaction fully before opening replacement",
    async (service) => {
      const f = await fixture();
      const gate = deferred();
      const entered = deferred();
      const transaction = f.manager.transaction.bind(f.manager);
      vi.spyOn(f.manager, "transaction").mockImplementationOnce(
        async (callback) => {
          return transaction(async (db) => {
            entered.resolve();
            await gate.promise;
            return callback(db);
          });
        }
      );
      const pending =
        service === "local"
          ? (
              f.local as unknown as {
                finishWithStatus: (
                  job: string,
                  asset: string,
                  clip: string,
                  status: string,
                  clipStatus: string,
                  message: string
                ) => Promise<void>;
              }
            ).finishWithStatus(
              "j",
              "a",
              "c",
              "ERROR",
              "failed",
              "original only"
            )
          : f.cloud.fail({ jobId: "j", message: "original only" });
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      let switched = false;
      const switching = f.switchLibrary().then(() => {
        switched = true;
      });
      await flush();
      expect(switched).toBe(false);
      gate.resolve();
      await switching;
      await rejected;
      await f.assertReplacement();
    }
  );

  it.each(["register", "registerImage", "complete"] as const)(
    "cloud %s cannot cross a delayed root into a replacement DB",
    async (method) => {
      const f = await fixture();
      const gate = deferred<string>();
      f.getRoot.mockImplementationOnce(() => gate.promise);
      const pending =
        method === "register"
          ? f.cloud.register(registration)
          : method === "registerImage"
            ? f.cloud.registerImage(imageRegistration)
            : f.cloud.complete({
                jobId: "j",
                relativePath: "saved.png",
                sizeBytes: 5
              });
      const rejected = expect(pending).rejects.toThrow();
      let switched = false;
      const switching = f.switchLibrary().then(() => {
        switched = true;
      });
      await flush();
      expect(switched).toBe(false);
      gate.resolve(f.pair[0]!);
      await switching;
      await rejected;
      await f.assertReplacement();
      expect(await f.manager.get().select().from(cloudRenderJobs)).toHaveLength(
        1
      );
    }
  );

  it("drains cloud thumbnail writes and suppresses late image callbacks", async () => {
    const f = await fixture();
    const gate = deferred();
    const entered = deferred();
    vi.mocked(atomicWriteFile).mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    const pending = f.cloud.complete({
      jobId: "j",
      relativePath: "saved.png",
      sizeBytes: 5
    });
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    let switched = false;
    const switching = f.switchLibrary().then(() => {
      switched = true;
    });
    await flush();
    expect(switched).toBe(false);
    gate.resolve();
    await switching;
    await rejected;
    await f.assertReplacement();
  });

  it("refuses new local and cloud work while suspended, without discarding cached outputs", async () => {
    const f = await fixture();
    await Promise.all([f.local.suspend(), f.cloud.libraryWork.suspend()]);
    for (const action of [
      () => f.local.kick(),
      () => f.local.listQueue(),
      () => f.local.reconcileInterruptedRenders(),
      () => f.local.submit(request),
      () => f.local.cancel("j"),
      () => f.cloud.register(registration),
      () => f.cloud.registerImage(imageRegistration),
      () =>
        f.cloud.complete({
          jobId: "j",
          relativePath: "saved.png",
          sizeBytes: 5
        }),
      () => f.cloud.fail({ jobId: "j", message: "no" })
    ])
      await expect(
        Promise.resolve().then(async () => {
          await action();
        })
      ).rejects.toThrow();
    await f.assertReplacement();
  });

  it("stale detached startup recovery cannot restart a timer or publish replacement health", async () => {
    const f = await fixture();
    const gate = deferred();
    f.policy.mockImplementationOnce(() => gate.promise);
    f.local.startWithRecovery();
    await f.switchLibrary();
    gate.resolve();
    await flush();
    expect(mocks.settle).not.toHaveBeenCalled();
    await f.assertReplacement();
  });

  it.each(["image", "video"] as const)(
    "drains %s ingestion root resolution without publishing into the replacement",
    async (kind) => {
      const f = await fixture();
      const gate = deferred<string>();
      f.getRoot.mockImplementationOnce(() => gate.promise);
      const job = (await f.manager.get().select().from(imageRenderJobs))[0]!;
      const ingestion = f.local as unknown as {
        completeImageBytes: (
          job: typeof imageRenderJobs.$inferSelect,
          bytes: Buffer,
          provider: string
        ) => Promise<void>;
        completeVideoFile: (
          job: typeof imageRenderJobs.$inferSelect,
          request: object,
          file: string
        ) => Promise<void>;
      };
      const pending =
        kind === "image"
          ? ingestion.completeImageBytes(job, Buffer.from("image"), "fixture")
          : ingestion.completeVideoFile(
              job,
              {},
              path.join(f.pair[0]!, "saved.png")
            );
      const rejected = expect(pending).rejects.toThrow();
      let switched = false;
      const switching = f.switchLibrary().then(() => {
        switched = true;
      });
      await flush();
      expect(switched).toBe(false);
      gate.resolve(f.pair[0]!);
      await switching;
      await rejected;
      await f.assertReplacement();
    }
  );
});

it.each(["trim", "filter"] as const)(
  "cleans captured %s partial output after abort, before releasing library ownership",
  async (kind) => {
    const f = await fixture();
    const output = path.join(f.pair[0]!, "temp", "partial.mp4");
    const closed = deferred();
    const started = deferred();
    vi.mocked(runLibraryFfmpeg).mockImplementationOnce(async () => {
      await writeFile(output, "partial decoder bytes");
      started.resolve();
      await closed.promise;
      throw new Error("aborted local decoder");
    });
    const media = f.local as unknown as {
      trimVideo: (
        input: string,
        output: string,
        start: number,
        end: number
      ) => Promise<void>;
      filterVideoFile: (
        input: string,
        output: string,
        filter: string,
        message: string
      ) => Promise<void>;
    };
    const pending =
      kind === "trim"
        ? media.trimVideo("old.mp4", output, 0, 1)
        : media.filterVideoFile("old.mp4", output, "crop=32:24", "fixture");
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    let switched = false;
    const switching = f.switchLibrary().then(() => {
      switched = true;
    });
    await flush();
    expect(switched).toBe(false);
    expect(await readFile(output, "utf8")).toBe("partial decoder bytes");
    closed.resolve();
    await switching;
    await rejected;
    await expect(stat(output)).rejects.toThrow();
    await f.assertReplacement();
  }
);
