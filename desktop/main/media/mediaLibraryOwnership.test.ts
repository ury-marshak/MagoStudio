import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS, type LocalVideoImport } from "../../shared/contracts";
import type { CloudProjectMirrorRepository } from "../database/cloudProjectMirrorRepository";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { assets, projects, scriptProjectMedia } from "../database/schema";
import { ScriptProjectSnapshotRepository } from "../database/scriptProjectSnapshotRepository";
import { registerLibraryHandlers } from "../ipc/registerLibraryHandlers";
import { registerProjectHandlers } from "../ipc/registerProjectHandlers";
import { clearLibraryIssues, listLibraryIssues } from "../libraryHealth";
import type { LibrarySettings } from "../librarySettings";
import { LibraryWorkSession } from "../libraryWorkSession";
import { registerMediaProtocol } from "../rendererProtocol";

import { createImageThumbnail } from "./imageThumbnail";
import { VideoFrameService } from "./videoFrameService";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  protocol: vi.fn(),
  trusted: vi.fn(),
  dialog: vi.fn(),
  spawn: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  protocol: { handle: mocks.protocol, registerSchemesAsPrivileged: vi.fn() },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.dialog },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  shell: {}
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../ipc/trustedSender", () => ({
  requireTrustedSender: mocks.trusted
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
vi.mock("./imageThumbnail", () => ({ createImageThumbnail: vi.fn() }));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const directories: string[] = [];
const managers: DatabaseManager[] = [];
const owners: LibraryWorkSession<undefined>[] = [];
const child = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockReset();
  clearLibraryIssues();
  vi.mocked(createImageThumbnail).mockImplementation(async (source, output) => {
    await writeFile(output, `thumbnail:${await readFile(source, "utf8")}`);
  });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const work of owners.splice(0)) await work.suspend();
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearLibraryIssues();
});

const fixture = async () => {
  const roots = await Promise.all(
    [0, 1].map(() => mkdtemp(path.join(tmpdir(), "mago-media-owner-")))
  );
  directories.push(...roots);
  const manager = new DatabaseManager();
  managers.push(manager);
  const now = new Date();
  for (const root of roots) {
    await manager.open(root!);
    await writeFile(path.join(root!, "video.mp4"), path.basename(root!));
    await writeFile(
      path.join(root!, "thumbnails", "assets", "same.jpg"),
      path.basename(root!)
    );
    await manager.get().insert(projects).values({
      id: "project",
      name: "Fixture",
      createdAt: now,
      updatedAt: now
    });
    await manager
      .get()
      .insert(assets)
      .values({
        id: "asset",
        name: "Video",
        type: "video",
        origin: "uploaded",
        sourcePath: path.join(root!, "video.mp4"),
        status: "available",
        frameCount: 48,
        width: 16,
        height: 9,
        fps: 24_000,
        duration: 2000,
        thumbnailRelativePath: "thumbnails/assets/same.jpg",
        dataJson: JSON.stringify({ size: [16, 9], total_frames: 48 }),
        createdAt: now,
        updatedAt: now
      });
    await manager.get().insert(scriptProjectMedia).values({
      id: "asset",
      projectId: "project",
      sourceUrl: "https://history.invalid/video.mp4",
      relativePath: "video.mp4",
      createdAt: now,
      updatedAt: now
    });
  }
  let root = roots[0]!;
  await manager.open(root);
  const getRoot = vi.fn(async () => root);
  const repository = new ProjectRepository(manager, getRoot);
  const scripts = new ScriptProjectSnapshotRepository(manager, getRoot);
  const work = new LibraryWorkSession(() => undefined);
  owners.push(work);
  const service = new VideoFrameService(repository, work);
  const settings = {
    getLibraryRoot: getRoot,
    get: async () => ({ appMode: "offline" }),
    getAppMode: async () => "offline",
    assertWritable: vi.fn(async () => {}),
    setLibraryRoot: vi.fn(async (value: string) => {
      root = value;
    })
  } as unknown as LibrarySettings;
  registerMediaProtocol(repository, scripts, settings, work);
  const protocol = mocks.protocol.mock.calls.at(-1)![1] as (
    request: Request
  ) => Promise<Response>;
  const request = (kind = "asset", init?: RequestInit) =>
    protocol(new Request(`mago-media://${kind}/asset`, init));
  const replace = async () => {
    await work.suspend();
    root = roots[1]!;
    await manager.open(root);
    work.reset();
  };
  const registerImports = () => {
    registerProjectHandlers(
      repository,
      {} as CloudProjectMirrorRepository,
      manager,
      settings,
      undefined,
      undefined,
      work
    );
    return mocks.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.projectsImportVideos
    )![1] as (event: unknown, value: unknown) => Promise<unknown>;
  };
  return {
    roots,
    manager,
    getRoot,
    repository,
    scripts,
    work,
    service,
    settings,
    protocol,
    request,
    replace,
    registerImports
  };
};

const videoInput = (
  root: string
): { projectId: string; videos: LocalVideoImport[] } => ({
  projectId: "project",
  videos: [
    {
      sourcePath: path.join(root, "video.mp4"),
      name: "Imported.mp4",
      durationSeconds: 2,
      fps: 24,
      width: 16,
      height: 9,
      frameCount: 48,
      thumbnailDataUrl: "data:image/png;base64,eA=="
    }
  ]
});

describe("library-owned media protocol", () => {
  it.each(["asset", "thumbnail", "script-project", "script-project-thumbnail"])(
    "serves local %s bytes from each reused-ID library without remote reads",
    async (kind) => {
      const test = await fixture();
      const fetchTrap = vi.fn(() => {
        throw new Error("Unexpected network");
      });
      vi.stubGlobal("fetch", fetchTrap);
      const first = await test.request(kind);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.text()).toContain(path.basename(test.roots[0]!));
      await test.replace();
      expect(await (await test.request(kind)).text()).toContain(
        path.basename(test.roots[1]!)
      );
      expect(fetchTrap).not.toHaveBeenCalled();
    }
  );

  it.each(["thumbnail", "script-project"])(
    "drains a delayed %s root lookup before replacement, without opening stale bytes",
    async (kind) => {
      const test = await fixture();
      const gate = deferred<string>();
      test.getRoot.mockReturnValueOnce(gate.promise);
      const response = test.request(kind);
      await vi.waitFor(() => expect(test.getRoot).toHaveBeenCalledOnce());
      let replaced = false;
      const replacement = test.replace().then(() => {
        replaced = true;
      });
      await flush();
      expect(replaced).toBe(false);
      gate.resolve(test.roots[0]!);
      expect((await response).status).toBe(404);
      await replacement;
      expect(createReadStream).not.toHaveBeenCalled();
      expect(listLibraryIssues()).toEqual([]);
      expect(await (await test.request(kind)).text()).toContain(
        path.basename(test.roots[1]!)
      );
    }
  );

  it("drains an issued stat and suppresses stale health callbacks", async () => {
    const test = await fixture();
    const stats = await stat(path.join(test.roots[0]!, "video.mp4"));
    const gate = deferred<typeof stats>();
    vi.mocked(stat).mockReturnValueOnce(gate.promise);
    const response = test.request();
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(2));
    let replaced = false;
    const replacement = test.replace().then(() => {
      replaced = true;
    });
    await flush();
    expect(replaced).toBe(false);
    gate.resolve(stats);
    expect((await response).status).toBe(404);
    await replacement;
    expect(createReadStream).not.toHaveBeenCalled();
    expect(listLibraryIssues()).toEqual([]);
  });

  it("cancels an unconsumed local stream and waits for its actual close", async () => {
    const test = await fixture();
    const source = new PassThrough();
    vi.mocked(createReadStream).mockReturnValueOnce(
      source as unknown as ReturnType<typeof createReadStream>
    );
    const response = await test.request();
    let closed = false;
    source.once("close", () => {
      closed = true;
    });
    await test.replace();
    expect(source.destroyed).toBe(true);
    expect(closed).toBe(true);
    await expect(response.text()).rejects.toThrow();
    expect(listLibraryIssues()).toEqual([]);
  });

  it("cancels an active file body on request abort, retaining library availability", async () => {
    const test = await fixture();
    const source = new PassThrough();
    vi.mocked(createReadStream).mockReturnValueOnce(
      source as unknown as ReturnType<typeof createReadStream>
    );
    const abort = new AbortController();
    const response = await test.request("asset", { signal: abort.signal });
    const text = expect(response.text()).rejects.toThrow();
    abort.abort();
    await text;
    await vi.waitFor(() => expect(source.closed).toBe(true));
    expect(test.work.signal.aborted).toBe(false);
    expect(await (await test.request()).text()).toContain(
      path.basename(test.roots[0]!)
    );
  });

  it("preserves HEAD, valid byte ranges and invalid-range handling", async () => {
    const test = await fixture();
    const head = await test.request("asset", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const partial = await test.request("asset", {
      headers: { range: "bytes=0-3" }
    });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("mago");
    expect(
      (await test.request("asset", { headers: { range: "bytes=99999-" } }))
        .status
    ).toBe(416);
  });

  it("handles empty files without starting a negative-end stream", async () => {
    const test = await fixture();
    await writeFile(path.join(test.roots[0]!, "video.mp4"), "");
    const response = await test.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it("refuses new requests throughout suspension", async () => {
    const test = await fixture();
    await test.work.suspend();
    expect((await test.request()).status).toBe(404);
    expect(createReadStream).not.toHaveBeenCalled();
    expect(listLibraryIssues()).toEqual([]);
  });

  it("drains an issued thumbnail build before replacing and never publishes its stale result", async () => {
    const test = await fixture();
    const started = deferred<void>();
    const finish = deferred<void>();
    vi.mocked(createImageThumbnail).mockImplementationOnce(
      async (_source, output, signal) => {
        started.resolve();
        await finish.promise;
        await writeFile(output, "old thumbnail");
        expect(signal?.aborted).toBe(true);
      }
    );
    const response = test.request("script-project-thumbnail");
    await started.promise;
    let replaced = false;
    const replacement = test.replace().then(() => {
      replaced = true;
    });
    await flush();
    expect(replaced).toBe(false);
    finish.resolve();
    expect((await response).status).toBe(404);
    await replacement;
    await expect(
      stat(path.join(test.roots[0]!, "video.mp4.thumbnail.jpg"))
    ).rejects.toThrow();
    expect(
      await (await test.request("script-project-thumbnail")).text()
    ).toContain(path.basename(test.roots[1]!));
    expect(listLibraryIssues()).toEqual([]);
  });
});

describe("library-owned frame and filmstrip children", () => {
  it.each(["frame", "filmstrip"])(
    "does not spawn a %s after a delayed old-library path",
    async (kind) => {
      const test = await fixture();
      const gate = deferred<string | null>();
      const resolve = vi
        .spyOn(test.repository, "resolveMediaPath")
        .mockReturnValueOnce(gate.promise);
      const result =
        kind === "frame"
          ? test.service.extractFrame({
              assetId: "asset",
              frameNumber: 0,
              fps: 24
            })
          : test.service.generateFilmstrip({
              assetId: "asset",
              width: 100,
              frameHeight: 20
            });
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
      let replaced = false;
      const replacement = test.replace().then(() => {
        replaced = true;
      });
      await flush();
      expect(replaced).toBe(false);
      gate.resolve(path.join(test.roots[0]!, "video.mp4"));
      await rejected;
      await replacement;
      expect(mocks.spawn).not.toHaveBeenCalled();
    }
  );

  it.each(["frame", "filmstrip"])(
    "kills an active %s child, drains close and discards late output",
    async (kind) => {
      const test = await fixture();
      const old = child();
      mocks.spawn.mockReturnValueOnce(old);
      const result =
        kind === "frame"
          ? test.service.extractFrame({
              assetId: "asset",
              frameNumber: 0,
              fps: 24
            })
          : test.service.generateFilmstrip({
              assetId: "asset",
              width: 100,
              frameHeight: 20
            });
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
      let replaced = false;
      const replacement = test.replace().then(() => {
        replaced = true;
      });
      expect(old.kill).toHaveBeenCalledWith("SIGKILL");
      old.stdout.emit("data", Buffer.from("late jpeg"));
      await flush();
      expect(replaced).toBe(false);
      old.emit("close", 0);
      await rejected;
      await replacement;
      const fresh = child();
      mocks.spawn.mockReturnValueOnce(fresh);
      const preview = test.service.extractFrame({
        assetId: "asset",
        frameNumber: 0,
        fps: 24
      });
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
      expect(mocks.spawn.mock.calls[1]![1]).toContain(
        path.join(test.roots[1]!, "video.mp4")
      );
      fresh.stdout.emit("data", Buffer.from("new jpeg"));
      fresh.emit("close", 0);
      await expect(preview).resolves.toBe(
        `data:image/jpeg;base64,${Buffer.from("new jpeg").toString("base64")}`
      );
    }
  );

  it("keeps a timed-out child drained until close", async () => {
    const test = await fixture();
    vi.spyOn(test.repository, "resolveMediaPath").mockResolvedValue(
      path.join(test.roots[0]!, "video.mp4")
    );
    vi.useFakeTimers();
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);
    const result = test.service.extractFrame({
      assetId: "asset",
      frameNumber: 0,
      fps: 24
    });
    const rejected = expect(result).rejects.toThrow("timed out");
    await flush();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    let drained = false;
    const suspend = test.work.suspend().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    process.emit("close", 1);
    await rejected;
    await suspend;
  });
});

describe("library-owned video imports", () => {
  it("captures ownership before root lookup and does not open a stale database", async () => {
    const test = await fixture();
    const importVideos = test.registerImports();
    test.manager.close();
    const gate = deferred<string>();
    test.getRoot.mockReturnValueOnce(gate.promise);
    const open = vi.spyOn(test.manager, "open");
    const result = importVideos({}, videoInput(test.roots[0]!));
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(test.getRoot).toHaveBeenCalledOnce());
    const suspend = test.work.suspend();
    gate.resolve(test.roots[0]!);
    await rejected;
    await suspend;
    expect(open).not.toHaveBeenCalled();
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it("drains the complete multi-await import and keeps new rows/files out of the replacement", async () => {
    const test = await fixture();
    const importVideos = test.registerImports();
    const gate = deferred<string>();
    test.getRoot.mockReturnValueOnce(gate.promise);
    const result = importVideos({}, videoInput(test.roots[0]!));
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(test.getRoot).toHaveBeenCalledOnce());
    let replaced = false;
    const replacement = test.replace().then(() => {
      replaced = true;
    });
    await flush();
    expect(replaced).toBe(false);
    gate.resolve(test.roots[0]!);
    await rejected;
    await replacement;
    expect(await test.manager.get().select().from(assets)).toHaveLength(1);
    expect(
      await readdir(path.join(test.roots[1]!, "thumbnails", "assets"))
    ).toEqual(["same.jpg"]);
    await test.manager.open(test.roots[0]!);
    expect(await test.manager.get().select().from(assets)).toHaveLength(2);
    expect(
      await readdir(path.join(test.roots[0]!, "thumbnails", "assets"))
    ).toHaveLength(2);
  });

  it("keeps media suspended if library opening fails", async () => {
    const test = await fixture();
    test.registerImports();
    registerLibraryHandlers({
      settings: test.settings,
      databaseManager: test.manager,
      repository: test.repository,
      beforeLibraryChange: () => test.work.suspend(),
      afterLibraryChange: () => test.work.reset()
    });
    mocks.dialog.mockResolvedValue({
      canceled: false,
      filePaths: [test.roots[1]!]
    });
    vi.spyOn(test.manager, "open").mockRejectedValueOnce(
      new Error("fixture open failure")
    );
    const choose = mocks.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.libraryChoose
    )![1];
    await expect(choose({ sender: {} })).rejects.toThrow(
      "fixture open failure"
    );
    expect(test.work.signal.aborted).toBe(true);
    expect((await test.request()).status).toBe(404);
    await expect(
      test.service.extractFrame({ assetId: "asset", frameNumber: 0, fps: 24 })
    ).rejects.toThrow();
  });
});

describe("library-owned cloud protocol bodies", () => {
  const cloudRequest = (test: Awaited<ReturnType<typeof fixture>>) => {
    const url = `https://${resolveCloudConfig().cloudStorageHosts[0]}/fixture.mp4`;
    return test.protocol(
      new Request(`mago-media://cloud-storage/?url=${encodeURIComponent(url)}`)
    );
  };

  it("cancels late abort-ignoring headers and drains body cleanup before replacement", async () => {
    const test = await fixture();
    vi.spyOn(test.settings, "getAppMode").mockResolvedValue("cloud");
    const headers = deferred<Response>();
    const cleanup = deferred<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const fetch = vi.fn((_url: URL, _init: RequestInit) => headers.promise);
    vi.stubGlobal("fetch", fetch);
    const response = cloudRequest(test);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    let replaced = false;
    const replacement = test.replace().then(() => {
      replaced = true;
    });
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
    headers.resolve(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(replaced).toBe(false);
    cleanup.resolve();
    expect((await response).status).toBe(404);
    await replacement;
    expect(listLibraryIssues()).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("owns an issued body after headers, including a pending read and delayed cancel", async () => {
    const test = await fixture();
    vi.spyOn(test.settings, "getAppMode").mockResolvedValue("cloud");
    const cleanup = deferred<void>();
    const cancel = vi.fn(() => cleanup.promise);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel })))
    );
    const response = await cloudRequest(test);
    expect(response.status).toBe(200);
    const body = expect(response.text()).rejects.toThrow();
    let replaced = false;
    const replacement = test.replace().then(() => {
      replaced = true;
    });
    await body;
    expect(cancel).toHaveBeenCalledOnce();
    await flush();
    expect(replaced).toBe(false);
    cleanup.resolve();
    await replacement;
    expect(listLibraryIssues()).toEqual([]);
  });

  it("refuses account-free remote reads before transport while keeping local bytes available", async () => {
    const test = await fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await cloudRequest(test)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(await (await test.request()).text()).toContain(
      path.basename(test.roots[0]!)
    );
  });
});

describe("queued thumbnails and import continuations", () => {
  it("drops queued thumbnail starts during teardown and drains active builders", async () => {
    const test = await fixture();
    const now = new Date();
    for (const id of ["second", "third"]) {
      await writeFile(path.join(test.roots[0]!, `${id}.mp4`), id);
      await test.manager
        .get()
        .insert(scriptProjectMedia)
        .values({
          id,
          projectId: "project",
          sourceUrl: `https://history.invalid/${id}.mp4`,
          relativePath: `${id}.mp4`,
          createdAt: now,
          updatedAt: now
        });
    }
    const gate = deferred<void>();
    vi.mocked(createImageThumbnail).mockImplementation(
      async (_source, output) => {
        await gate.promise;
        await writeFile(output, "old thumbnail");
      }
    );
    const responses = ["asset", "second", "third"].map((id) =>
      test.protocol(new Request(`mago-media://script-project-thumbnail/${id}`))
    );
    await vi.waitFor(() =>
      expect(createImageThumbnail).toHaveBeenCalledTimes(2)
    );
    let replaced = false;
    const replacement = test.replace().then(() => {
      replaced = true;
    });
    await flush();
    expect(replaced).toBe(false);
    gate.resolve();
    expect(
      (await Promise.all(responses)).map((response) => response.status)
    ).toEqual([404, 404, 404]);
    await replacement;
    expect(createImageThumbnail).toHaveBeenCalledTimes(2);
    expect(await readdir(test.roots[1]!)).not.toContain(
      "video.mp4.thumbnail.jpg"
    );
    expect(listLibraryIssues()).toEqual([]);
  });

  it("drains an already-issued database open before refusing an old video import", async () => {
    const test = await fixture();
    const importVideos = test.registerImports();
    test.manager.close();
    const gate = deferred<void>();
    const openDatabase = test.manager.open.bind(test.manager);
    const open = vi
      .spyOn(test.manager, "open")
      .mockImplementationOnce(async (root) => {
        await gate.promise;
        await openDatabase(root);
      });
    const importCall = vi.spyOn(test.repository, "importVideos");
    const result = importVideos({}, videoInput(test.roots[0]!));
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    let replaced = false;
    const replacement = test.replace().then(() => {
      replaced = true;
    });
    await flush();
    expect(replaced).toBe(false);
    gate.resolve();
    await rejected;
    await replacement;
    expect(importCall).not.toHaveBeenCalled();
    expect(await test.manager.get().select().from(assets)).toHaveLength(1);
  });

  it("keeps media unavailable if replacement settings persistence fails", async () => {
    const test = await fixture();
    registerLibraryHandlers({
      settings: test.settings,
      databaseManager: test.manager,
      repository: test.repository,
      beforeLibraryChange: () => test.work.suspend(),
      afterLibraryChange: () => test.work.reset()
    });
    mocks.dialog.mockResolvedValue({
      canceled: false,
      filePaths: [test.roots[1]!]
    });
    vi.mocked(test.settings.setLibraryRoot).mockRejectedValueOnce(
      new Error("fixture settings failure")
    );
    const choose = mocks.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.libraryChoose
    )![1];
    await expect(choose({ sender: {} })).rejects.toThrow(
      "fixture settings failure"
    );
    expect((await test.request()).status).toBe(404);
    expect(test.work.signal.aborted).toBe(true);
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it("resumes media only after the library and settings both open successfully", async () => {
    const test = await fixture();
    const gate = deferred<void>();
    const setRoot = test.settings.setLibraryRoot.bind(test.settings);
    vi.mocked(test.settings.setLibraryRoot).mockImplementationOnce(
      async (root) => {
        await gate.promise;
        await setRoot(root);
      }
    );
    registerLibraryHandlers({
      settings: test.settings,
      databaseManager: test.manager,
      repository: test.repository,
      beforeLibraryChange: () => test.work.suspend(),
      afterLibraryChange: () => test.work.reset()
    });
    mocks.dialog.mockResolvedValue({
      canceled: false,
      filePaths: [test.roots[1]!]
    });
    const choose = mocks.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.libraryChoose
    )![1];
    const selection = choose({ sender: {} });
    await vi.waitFor(() =>
      expect(test.settings.setLibraryRoot).toHaveBeenCalled()
    );
    expect((await test.request()).status).toBe(404);
    gate.resolve();
    await selection;
    expect(await (await test.request()).text()).toContain(
      path.basename(test.roots[1]!)
    );
  });
});
