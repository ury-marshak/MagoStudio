import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC_CHANNELS,
  type LocalAsset,
  type VlmModelStatus
} from "../../shared/contracts";
import type { CloudProjectMirrorRepository } from "../database/cloudProjectMirrorRepository";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { assets, projects } from "../database/schema";
import { registerLibraryHandlers } from "../ipc/registerLibraryHandlers";
import { registerProjectHandlers } from "../ipc/registerProjectHandlers";
import { registerVlmHandlers } from "../ipc/registerVlmHandlers";
import {
  clearLibraryIssues,
  listLibraryIssues,
  reportLibraryIssue
} from "../libraryHealth";
import type { LibrarySettings } from "../librarySettings";

import { LocalI2vPromptAdapter } from "./localI2vPromptAdapter";
import { extractVideoCaptionFrames } from "./videoFrames";
import type { VisionGenerator } from "./visionGenerator";
import { VlmService } from "./vlmService";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  trusted: vi.fn(),
  dialog: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.dialog },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  shell: {},
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 10, height: 10 }),
      toPNG: () => Buffer.from("fixture PNG")
    })
  }
}));
vi.mock("../ipc/trustedSender", () => ({
  requireTrustedSender: mocks.trusted
}));
vi.mock("./videoFrames", () => ({ extractVideoCaptionFrames: vi.fn() }));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
const caption = {
  positive: {
    content: "fixture caption",
    setting: "studio",
    aesthetics: "photo"
  },
  negative: ""
};
const ready = { ready: true } as VlmModelStatus;
const directories: string[] = [];
const managers: DatabaseManager[] = [];
const services: VlmService[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  clearLibraryIssues();
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.suspend();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
  vi.restoreAllMocks();
  clearLibraryIssues();
});

const fixture = async (data: Record<string, unknown> = {}) => {
  const roots = await Promise.all(
    [0, 1].map(() => mkdtemp(path.join(tmpdir(), "mago-vlm-owner-")))
  );
  directories.push(...roots);
  const manager = new DatabaseManager();
  managers.push(manager);
  const now = new Date();
  for (const root of roots) {
    await manager.open(root!);
    const sourcePath = path.join(root!, "image.png");
    await writeFile(sourcePath, "fixture image bytes");
    await manager
      .get()
      .insert(projects)
      .values({ id: "project", name: root!, createdAt: now, updatedAt: now });
    await manager
      .get()
      .insert(assets)
      .values({
        id: "image",
        name: "Image",
        type: "image",
        origin: "uploaded",
        sourcePath,
        status: "available",
        dataJson: JSON.stringify(data),
        createdAt: now,
        updatedAt: now
      });
  }
  let root = roots[0]!;
  await manager.open(root);
  const repository = new ProjectRepository(manager, async () => root);
  const generate = vi
    .fn<VisionGenerator>()
    .mockResolvedValue({ text: "New library description", model: "fixture" });
  const probe = vi.fn(async () => ready);
  const service = new VlmService(repository, generate, probe);
  services.push(service);
  const replace = async () => {
    await service.suspend();
    root = roots[1]!;
    await manager.open(root);
    service.reset();
  };
  const readData = async () => {
    const [row] = await manager
      .get()
      .select()
      .from(assets)
      .where(eq(assets.id, "image"));
    return JSON.parse(row!.dataJson) as Record<string, unknown>;
  };
  return {
    roots,
    manager,
    repository,
    generate,
    probe,
    service,
    replace,
    readData,
    root: () => root
  };
};

const ipc = (test: Awaited<ReturnType<typeof fixture>>) => {
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false
  });
  const text = vi.fn(async () => '{"positive_prompt":"adapted"}');
  const adapter = new LocalI2vPromptAdapter({
    getAsset: (id) =>
      test.service.libraryWork.boundary(() => test.repository.getAsset(id)),
    describeImage: (id, signal) => test.service.describeImageAsset(id, signal),
    captionVideo: async (id, signal) =>
      (await test.service.captionAsset(id, signal)).prompt,
    runTextPrompt: text
  });
  registerVlmHandlers(test.service, adapter, async () => true);
  const handler = (channel: string) =>
    mocks.handle.mock.calls.find(([name]) => name === channel)![1];
  return { sender, event: { sender }, handler, text };
};

describe("general VLM library ownership", () => {
  it.each(["caption", "description"])(
    "suppresses a delayed %s cache hit and drains its issued read",
    async (kind) => {
      const test = await fixture({
        prompt: caption,
        description: "Old cached description"
      });
      const gate = deferred<LocalAsset | null>();
      const get = vi
        .spyOn(test.repository, "getAsset")
        .mockReturnValueOnce(gate.promise);
      const result =
        kind === "caption"
          ? test.service.captionAsset("image")
          : test.service.describeImageAsset("image");
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      let drained = false;
      const suspend = test.service.suspend().then(() => {
        drained = true;
      });
      await rejected;
      await flush();
      expect(drained).toBe(false);
      gate.resolve({
        id: "image",
        name: "Image",
        filepath: "fixture",
        type: "IMAGE",
        data: { prompt: caption, description: "old" }
      } as LocalAsset);
      await suspend;
      expect(test.generate).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledTimes(1);
      await test.replace();
      await expect(test.service.describeImageAsset("image")).resolves.toBe(
        "Old cached description"
      );
    }
  );

  it.each(["caption", "description"])(
    "does not follow a stale %s source lookup into media/inference",
    async (kind) => {
      const test = await fixture();
      const gate = deferred<string | null>();
      const source = vi
        .spyOn(test.repository, "assetSourcePath")
        .mockReturnValueOnce(gate.promise);
      const result =
        kind === "caption"
          ? test.service.captionAsset("image")
          : test.service.describeImageAsset("image");
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(1));
      const suspend = test.service.suspend();
      gate.resolve(path.join(test.roots[0]!, "image.png"));
      await suspend;
      await rejected;
      await test.replace();
      expect(test.generate).not.toHaveBeenCalled();
      expect(await test.readData()).toEqual({});
    }
  );

  it.each(["late prose", "", "not JSON", JSON.stringify(caption)])(
    "releases switching from an abort-ignoring provider (%s) without repair or persistence",
    async (text) => {
      const test = await fixture();
      const gate = deferred<{ text: string; model: string }>();
      test.generate.mockReturnValueOnce(gate.promise);
      const old = test.service.captionAsset("image");
      const rejected = expect(old).rejects.toThrow();
      await vi.waitFor(() => expect(test.generate).toHaveBeenCalledTimes(1));
      const signal = test.generate.mock.calls[0]![0].signal!;
      await test.replace();
      await rejected;
      expect(signal.aborted).toBe(true);
      // The replacement does not sit behind the uncooperative provider's queue.
      await expect(test.service.describeImageAsset("image")).resolves.toBe(
        "New library description"
      );
      gate.resolve({ text, model: "old" });
      await flush();
      expect(test.generate).toHaveBeenCalledTimes(2);
      expect(await test.readData()).toEqual({
        description: "New library description"
      });
    }
  );

  it("drops queued inference across suspension and starts a fresh replacement queue", async () => {
    const test = await fixture();
    const gate = deferred<{ text: string; model: string }>();
    test.generate.mockReturnValueOnce(gate.promise);
    const active = test.service.enhancePrompt({ query: "old active" });
    const activeRejected = expect(active).rejects.toThrow();
    await vi.waitFor(() => expect(test.generate).toHaveBeenCalledTimes(1));
    const queued = test.service.autoPrompt({
      version: "img2img_mago",
      styleReferenceImage: "Zg==",
      sourceVideoFrame: "Zg=="
    });
    const queuedRejected = expect(queued).rejects.toThrow();
    await test.replace();
    await activeRejected;
    await queuedRejected;
    await expect(
      test.service.enhancePrompt({ query: "replacement" })
    ).resolves.toEqual({ enhanced_prompt: "New library description" });
    gate.resolve({ text: "malformed", model: "old" });
    await flush();
    expect(test.generate).toHaveBeenCalledTimes(2);
  });

  it("isolates shared description subscribers and cleanup with a reused asset ID", async () => {
    const test = await fixture();
    const oldGate = deferred<{ text: string; model: string }>();
    const newGate = deferred<{ text: string; model: string }>();
    test.generate
      .mockReturnValueOnce(oldGate.promise)
      .mockReturnValueOnce(newGate.promise);
    const first = new AbortController();
    const one = test.service.describeImageAsset("image", first.signal);
    const two = test.service.describeImageAsset("image");
    const rejectedOne = expect(one).rejects.toThrow();
    const rejectedTwo = expect(two).rejects.toThrow();
    await vi.waitFor(() => expect(test.generate).toHaveBeenCalledTimes(1));
    first.abort();
    await rejectedOne;
    expect(test.generate.mock.calls[0]![0].signal!.aborted).toBe(false);
    await test.replace();
    await rejectedTwo;
    const current = test.service.describeImageAsset("image");
    await vi.waitFor(() => expect(test.generate).toHaveBeenCalledTimes(2));
    oldGate.resolve({ text: "old", model: "old" });
    await flush();
    const joined = test.service.describeImageAsset("image");
    await flush();
    expect(test.generate).toHaveBeenCalledTimes(2);
    newGate.resolve({ text: "current", model: "new" });
    await expect(current).resolves.toBe("current");
    await expect(joined).resolves.toBe("current");
    expect(await test.readData()).toEqual({ description: "current" });
  });

  it.each(["caption", "description", "autoprompt"])(
    "drains a fully issued %s write before DB replacement",
    async (kind) => {
      const test = await fixture();
      test.generate.mockResolvedValue({
        text: kind === "caption" ? JSON.stringify(caption) : "description",
        model: "fixture"
      });
      const gate = deferred<void>();
      const entered = deferred<void>();
      const method =
        kind === "caption"
          ? "setAssetPrompt"
          : kind === "description"
            ? "setAssetDescriptionIfAbsent"
            : "appendAssetAutoPrompt";
      const original = test.repository[method].bind(test.repository);
      // Delay inside the issued repository boundary, then use the real multi-await writer.
      const spy = vi
        .spyOn(test.repository, method)
        .mockImplementation(async (...args: unknown[]) => {
          entered.resolve();
          await gate.promise;
          return Reflect.apply(original, undefined, args);
        });
      const result =
        kind === "caption"
          ? test.service.captionAsset("image")
          : kind === "description"
            ? test.service.describeImageAsset("image")
            : test.service.saveAutoPrompt({
                assetId: "image",
                videoAssetId: "video",
                version: "img2img_mago",
                positivePrompt: "saved"
              });
      const rejected = expect(result).rejects.toThrow();
      await entered.promise;
      let replaced = false;
      const replacement = test.replace().then(() => {
        replaced = true;
      });
      await flush();
      expect(replaced).toBe(false);
      gate.resolve();
      await replacement;
      await rejected;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await test.readData()).toEqual({});
      await test.manager.open(test.roots[0]!);
      expect(Object.keys(await test.readData()).length).toBeGreaterThan(0);
    }
  );

  it("drains issued video-frame media work but not inference", async () => {
    const test = await fixture();
    await test.manager
      .get()
      .update(assets)
      .set({
        type: "video",
        frameCount: 24,
        dataJson: JSON.stringify({ total_frames: 24 })
      })
      .where(eq(assets.id, "image"));
    const gate =
      deferred<Awaited<ReturnType<typeof extractVideoCaptionFrames>>>();
    vi.mocked(extractVideoCaptionFrames).mockReturnValueOnce(gate.promise);
    const result = test.service.captionAsset("image");
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() =>
      expect(extractVideoCaptionFrames).toHaveBeenCalledTimes(1)
    );
    let drained = false;
    const suspend = test.service.suspend().then(() => {
      drained = true;
    });
    await rejected;
    await flush();
    expect(drained).toBe(false);
    expect(
      vi.mocked(extractVideoCaptionFrames).mock.calls[0]![0].signal!.aborted
    ).toBe(true);
    gate.resolve({ firstFrame: Buffer.from("frame"), grids: [] });
    await suspend;
    expect(test.generate).not.toHaveBeenCalled();
  });

  it("captures automatic descriptions before a delayed readiness check", async () => {
    const test = await fixture();
    const gate = deferred<VlmModelStatus>();
    test.probe.mockReturnValueOnce(gate.promise);
    const get = vi.spyOn(test.repository, "getAsset");
    test.service.describeAssetLater("image");
    await test.replace();
    reportLibraryIssue({
      id: "Image description image",
      kind: "service",
      message: "replacement issue"
    });
    gate.resolve(ready);
    await flush();
    expect(get).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
    expect(listLibraryIssues()[0]?.message).toBe("replacement issue");
    test.service.describeAssetLater("image");
    await vi.waitFor(async () =>
      expect(await test.readData()).toEqual({
        description: "New library description"
      })
    );
  });

  it("ignores detached ingestion callbacks carrying an old lifetime", async () => {
    const test = await fixture();
    const origin = test.service.libraryWork.capture();
    await test.replace();
    test.service.describeAssetLater("image", origin);
    await flush();
    expect(test.probe).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
    expect(await test.readData()).toEqual({});
  });

  it.each([
    IPC_CHANNELS.vlmCaptionAsset,
    IPC_CHANNELS.vlmAutoPrompt,
    IPC_CHANNELS.vlmEnhancePrompt,
    IPC_CHANNELS.vlmAdaptI2vPrompt
  ])("captures IPC %s before its queued start", async (channel) => {
    const test = await fixture();
    const transport = ipc(test);
    const input =
      channel === IPC_CHANNELS.vlmCaptionAsset
        ? "image"
        : channel === IPC_CHANNELS.vlmAutoPrompt
          ? {
              version: "img2img_mago",
              styleReferenceImage: "Zg==",
              sourceVideoFrame: "Zg=="
            }
          : channel === IPC_CHANNELS.vlmEnhancePrompt
            ? { query: "courier" }
            : { prompt: "courier", reference_asset_ids: ["image"] };
    const get = vi.spyOn(test.repository, "getAsset");
    const result = transport.handler(channel)(
      transport.event,
      input,
      "request"
    );
    const rejected = expect(result).rejects.toThrow();
    await test.replace();
    await rejected;
    expect(get).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
    expect(transport.text).not.toHaveBeenCalled();
  });

  it("does not adapt stale cached references or degrade teardown to a generic description", async () => {
    const test = await fixture({ description: "cached" });
    const transport = ipc(test);
    const gate = deferred<LocalAsset | null>();
    const get = vi
      .spyOn(test.repository, "getAsset")
      .mockReturnValueOnce(gate.promise);
    const result = transport.handler(IPC_CHANNELS.vlmAdaptI2vPrompt)(
      transport.event,
      { prompt: "courier", reference_asset_ids: ["image"] },
      "adapt"
    );
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const suspend = test.service.suspend();
    gate.resolve({
      id: "image",
      name: "Image",
      filepath: "fixture",
      type: "IMAGE",
      data: { description: "old" }
    } as LocalAsset);
    await suspend;
    await rejected;
    await test.replace();
    expect(transport.text).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it("keeps general VLM unavailable after failed replacement opening", async () => {
    const test = await fixture();
    const settings = { assertWritable: vi.fn(), setLibraryRoot: vi.fn() };
    registerLibraryHandlers({
      settings: settings as unknown as LibrarySettings,
      databaseManager: {
        open: vi.fn().mockRejectedValue(new Error("failed open"))
      } as unknown as DatabaseManager,
      repository: test.repository,
      beforeLibraryChange: () => test.service.suspend(),
      afterLibraryChange: () => test.service.reset()
    });
    mocks.dialog.mockResolvedValue({
      canceled: false,
      filePaths: [test.roots[1]]
    });
    const handler = mocks.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.libraryChoose
    )![1];
    await expect(handler({ sender: {} })).rejects.toThrow("failed open");
    await expect(test.service.captionAsset("image")).rejects.toThrow();
    await expect(
      test.service.enhancePrompt({ query: "courier" })
    ).rejects.toThrow();
    await expect(
      test.service.saveAutoPrompt({
        assetId: "image",
        videoAssetId: "video",
        version: "img2img_mago",
        positivePrompt: "saved"
      })
    ).rejects.toThrow();
    await expect(test.service.status()).rejects.toThrow();
    test.service.describeAssetLater("image");
    await flush();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.probe).not.toHaveBeenCalled();
    expect(settings.setLibraryRoot).not.toHaveBeenCalled();
  });
});

describe("automatic image-import ownership", () => {
  const register = (
    test: Awaited<ReturnType<typeof fixture>>,
    settings?: LibrarySettings
  ) => {
    const imported = vi.fn((id: string) => test.service.describeAssetLater(id));
    registerProjectHandlers(
      test.repository,
      {} as CloudProjectMirrorRepository,
      test.manager,
      settings ??
        ({ getLibraryRoot: async () => test.root() } as LibrarySettings),
      imported,
      test.service.libraryWork
    );
    const handler = mocks.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.assetsImportImage
    )![1];
    const input = {
      projectId: "project",
      sourcePath: path.join(test.roots[0]!, "image.png"),
      name: "Imported",
      width: 10,
      height: 10,
      thumbnailDataUrl: "data:image/png;base64,Zml4dHVyZQ=="
    };
    return { imported, handler, input };
  };

  it("drains the complete issued import, suppressing its automatic callback after suspension", async () => {
    const test = await fixture();
    const transport = register(test);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = test.repository.importImage.bind(test.repository);
    vi.spyOn(test.repository, "importImage").mockImplementation(
      async (input) => {
        entered.resolve();
        await gate.promise;
        return original(input);
      }
    );
    const result = transport.handler({ sender: {} }, transport.input);
    const rejected = expect(result).rejects.toThrow();
    await entered.promise;
    let replaced = false;
    const replace = test.replace().then(() => {
      replaced = true;
    });
    await flush();
    expect(replaced).toBe(false);
    gate.resolve();
    await replace;
    await rejected;
    expect(transport.imported).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
    expect(await test.manager.get().select().from(assets)).toHaveLength(1);
    await test.manager.open(test.roots[0]!);
    expect(await test.manager.get().select().from(assets)).toHaveLength(2);
  });

  it("does not open a stale root or import after the first delayed lookup", async () => {
    const test = await fixture();
    test.manager.close();
    const gate = deferred<string | null>();
    const transport = register(test, {
      getLibraryRoot: () => gate.promise
    } as LibrarySettings);
    const open = vi.spyOn(test.manager, "open");
    const result = transport.handler({ sender: {} }, transport.input);
    const rejected = expect(result).rejects.toThrow();
    const suspend = test.service.suspend();
    gate.resolve(test.roots[0]!);
    await suspend;
    await rejected;
    expect(open).not.toHaveBeenCalled();
    expect(transport.imported).not.toHaveBeenCalled();
  });

  it("drains an already-issued database open without starting import or follow-up work", async () => {
    const test = await fixture();
    test.manager.close();
    const transport = register(test);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = test.manager.open.bind(test.manager);
    vi.spyOn(test.manager, "open").mockImplementationOnce(async (root) => {
      entered.resolve();
      await gate.promise;
      return original(root);
    });
    const imported = vi.spyOn(test.repository, "importImage");
    const result = transport.handler({ sender: {} }, transport.input);
    const rejected = expect(result).rejects.toThrow();
    await entered.promise;
    let drained = false;
    const suspend = test.service.suspend().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    gate.resolve();
    await suspend;
    await rejected;
    expect(imported).not.toHaveBeenCalled();
    expect(transport.imported).not.toHaveBeenCalled();
  });

  it("continues normal local import and background description in the replacement", async () => {
    const test = await fixture();
    await test.replace();
    const transport = register(test);
    const result = await transport.handler({ sender: {} }, transport.input);
    expect(transport.imported).toHaveBeenCalledWith(result.id);
    await vi.waitFor(async () =>
      expect(
        (await test.repository.getAsset(result.id))?.data.description
      ).toBe("New library description")
    );
  });
});
