import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: "",
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  choose: vi.fn(),
  put: vi.fn(),
  spawn: vi.fn(),
  beforeQuery: null as ((sql: string) => Promise<void>) | null,
  beforeStat: null as ((file: string) => Promise<void>) | null,
  beforeFileClose: null as ((file: string) => Promise<void>) | null
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => mocks.profile
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (...args: unknown[]) => Promise<unknown>
    ) => mocks.handlers.set(channel, handler)
  },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.choose },
  shell: {}
}));
vi.mock("node:https", async (original) => {
  const https = await original<typeof import("node:https")>();
  return {
    ...https,
    default: { ...https, request: mocks.put },
    request: mocks.put
  };
});
vi.mock("ffmpeg-static", () => ({ default: "ffmpeg" }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      await mocks.beforeStat?.(String(args[0]));
      return fs.stat(...args);
    }
  };
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    createReadStream: (file: string) => {
      const beforeClose = mocks.beforeFileClose;
      if (!beforeClose) return fs.createReadStream(file);
      return fs.createReadStream(file, {
        fs: {
          open: fs.open,
          read: fs.read,
          close(fd, callback) {
            void beforeClose(file).then(() => fs.close(fd, callback));
          }
        }
      });
    }
  };
});
vi.mock("drizzle-orm/sqlite-proxy", async (original) => {
  const sqlite = await original<typeof import("drizzle-orm/sqlite-proxy")>();
  return {
    ...sqlite,
    drizzle: (...[query, batch, config]: Parameters<typeof sqlite.drizzle>) =>
      sqlite.drizzle(
        async (...args) => {
          await mocks.beforeQuery?.(args[0]);
          return query(...args);
        },
        batch,
        config
      )
  };
});

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS as ipc } from "../../shared/contracts";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { assets, projects, scriptProjectMedia } from "../database/schema";
import { registerCloudHandlers } from "../ipc/registerCloudHandlers";
import { registerLibraryHandlers } from "../ipc/registerLibraryHandlers";
import { LibrarySettings } from "../librarySettings";

import { CloudLinkRepository } from "./cloudLinkRepository";
import { CloudRenderJobRepository } from "./cloudRenderJobRepository";
import { CloudRenderSubmitService } from "./cloudRenderSubmitService";
import { uploadCachePath } from "./uploadEncode";
import { UploadService } from "./uploadService";

const deferred = <T = void>() => {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const hold = () => {
  const entered = deferred();
  const gate = deferred();
  return {
    entered: entered.promise,
    release: gate.release,
    wait: async () => {
      entered.release();
      await gate.promise;
    }
  };
};
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const renderer = () => ({
  senderFrame: { url: `https://${resolveCloudConfig().rendererHost}/` },
  sender: { isDestroyed: () => false, send: vi.fn() }
});
const presignedUrl = "https://upload.invalid/fixture";
const preparedInput = { assetId: "video", presignedUrl };
const byteInput = {
  uploadId: "bytes",
  presignedUrl,
  contentType: "video/mp4",
  bytes: new Uint8Array([1, 2, 3])
};
const scriptInput = { assetId: "script-image", presignedUrl };
const remoteUrl = "https://saved.invalid/historical.webp";
const gatedRequests: Array<[string, unknown]> = [
  [ipc.cloudPrepareUpload, preparedInput],
  [ipc.cloudUploadPrepared, preparedInput],
  [ipc.cloudUploadAsset, scriptInput],
  [ipc.cloudUploadBytes, byteInput]
];
const allRequests: Array<[string, unknown]> = [
  ...gatedRequests,
  [ipc.cloudAssetInfo, "video"],
  [ipc.cloudCancelUploadBytes, byteInput.uploadId]
];

let manager: DatabaseManager;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  mocks.beforeQuery = mocks.beforeStat = mocks.beforeFileClose = null;
  mocks.profile = await mkdtemp(path.join(tmpdir(), "mago-upload-owner-"));
  manager = new DatabaseManager();
  mocks.put.mockImplementation(() => {
    throw new Error("Unexpected PUT");
  });
  mocks.spawn.mockImplementation(() => {
    throw new Error("Unexpected child");
  });
});
afterEach(async () => {
  manager.close();
  vi.restoreAllMocks();
  await rm(mocks.profile, { recursive: true, force: true });
});

const videoCache = (root: string) =>
  path.join(root, uploadCachePath({ assetId: "video" }));
const imageCache = (root: string) =>
  path.join(root, "cloud", "images", "script-image.png");
const fixture = async () => {
  const [original, replacement] = ["original", "replacement"].map((which) =>
    path.join(mocks.profile, which)
  ) as [string, string];
  for (const [index, root] of [original, replacement].entries()) {
    await manager.open(root);
    const sourcePath = path.join(root, "source.mp4");
    await writeFile(sourcePath, `video ${index}`);
    const relativePath = "script-projects/fixture.webp";
    await writeFile(path.join(root, relativePath), `image ${index}`);
    await mkdir(path.dirname(videoCache(root)), { recursive: true });
    await writeFile(videoCache(root), `encoded video ${index}`);
    await manager
      .get()
      .insert(projects)
      .values({ id: "project", name: `Library ${index}` });
    await manager
      .get()
      .insert(assets)
      .values({
        id: "video",
        name: `Video ${index}`,
        sourcePath,
        type: "video",
        status: "available",
        width: 1280 + index,
        height: 720
      });
    await manager.get().insert(scriptProjectMedia).values({
      id: "script-image",
      projectId: "project",
      sourceUrl: remoteUrl,
      relativePath
    });
  }
  await manager.open(original);
  const settings = new LibrarySettings();
  await settings.setLibraryRoot(original);
  await settings.setAppMode("cloud");
  const getRoot = () => settings.getLibraryRoot();
  const uploads = new UploadService(getRoot);
  const repository = new ProjectRepository(manager, getRoot);
  const links = new CloudLinkRepository(manager);
  const jobs = new CloudRenderJobRepository(manager);
  registerCloudHandlers({
    links,
    uploads,
    repository,
    renderJobs: jobs,
    renderSubmits: new CloudRenderSubmitService(manager, getRoot),
    databaseManager: manager,
    getLibraryRoot: getRoot,
    settings
  });
  const work = uploads.libraryWork;
  registerLibraryHandlers({
    settings,
    databaseManager: manager,
    repository,
    beforeLibraryChange: () => work.suspend(),
    afterLibraryChange: () => work.reset()
  });
  mocks.choose.mockResolvedValue({ canceled: false, filePaths: [replacement] });
  const event = renderer();
  const invoke = (channel: string, input?: unknown, sender = event) =>
    mocks.handlers.get(channel)!(sender, input);
  const choose = () => invoke(ipc.libraryChoose);
  const startSwitch = async () => {
    const opened = vi.spyOn(manager, "open");
    const signal = work.signal;
    const choosing = choose();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await flush();
    return { choosing, opened };
  };
  return {
    original,
    replacement,
    settings,
    uploads,
    event,
    invoke,
    choose,
    startSwitch
  };
};

/** Real Node streams, fake HTTPS. Request and response close gates can be
 * independent, including a response delivered while the request is closing. */
const mockPut = ({ lateHeaders = false, statusCode = 200 } = {}) => {
  const requestClose = hold();
  const bodyClose = hold();
  const headers = deferred<(response: Readable) => void>();
  const sent = deferred();
  const chunks: Buffer[] = [];
  const body = Object.assign(
    new Readable({
      read() {},
      destroy(error, callback) {
        void bodyClose.wait().then(() => callback(error));
      }
    }),
    { statusCode }
  );
  const request = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      sent.release();
      callback();
    },
    destroy(error, callback) {
      void requestClose.wait().then(() => callback(error));
    }
  });
  mocks.put.mockImplementationOnce((_url, _options, onResponse) => {
    headers.release(onResponse);
    if (!lateHeaders) void sent.promise.then(() => onResponse(body));
    return request;
  });
  return {
    body,
    requestClose,
    bodyClose,
    sent: sent.promise,
    deliverResponse: async () => (await headers.promise)(body),
    text: () => Buffer.concat(chunks).toString()
  };
};
const mockChild = () => {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: vi.fn()
  });
  const started = deferred<string[]>();
  mocks.spawn.mockImplementationOnce((_executable, args: string[]) => {
    started.release(args);
    return child;
  });
  return { child, started: started.promise };
};

it.each(gatedRequests)(
  "%s captures origin before permission without draining the settings read",
  async (channel, input) => {
    const f = await fixture();
    const gate = hold();
    vi.spyOn(f.settings, "getAppMode").mockImplementationOnce(async () => {
      await gate.wait();
      return "cloud";
    });
    const stale = observe(f.invoke(channel, input));
    await gate.entered;
    await f.choose();
    const root = vi.spyOn(f.settings, "getLibraryRoot");
    const query = vi.fn(async () => {});
    mocks.beforeQuery = query;
    gate.release();
    expect(await stale).toMatchObject({ name: "AbortError" });
    expect(query).not.toHaveBeenCalled();
    expect(root).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  }
);

it.each([
  [ipc.cloudAssetInfo, "video"],
  [ipc.cloudPrepareUpload, preparedInput],
  [ipc.cloudUploadAsset, scriptInput]
])(
  "%s drains its issued root read and refuses stale continuation",
  async (channel, input) => {
    const f = await fixture();
    const gate = hold();
    vi.spyOn(f.settings, "getLibraryRoot").mockImplementationOnce(async () => {
      await gate.wait();
      return f.original;
    });
    const stale = observe(f.invoke(channel as string, input));
    await gate.entered;
    const { choosing, opened } = await f.startSwitch();
    expect(opened).not.toHaveBeenCalled();
    gate.release();
    expect(await stale).toMatchObject({ name: "AbortError" });
    await choosing;
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expect(f.invoke(ipc.cloudAssetInfo, "video")).resolves.toMatchObject({
      name: "Video 1",
      width: 1281
    });
  }
);

it("drains the actual asset query and never issues a stale script-media fallback", async () => {
  const f = await fixture();
  const gate = hold();
  const queries: string[] = [];
  mocks.beforeQuery = async (sql) => {
    queries.push(sql);
    if (sql.includes('from "assets"')) await gate.wait();
  };
  const stale = observe(f.invoke(ipc.cloudAssetInfo, scriptInput.assetId));
  await gate.entered;
  const { choosing, opened } = await f.startSwitch();
  expect(opened).not.toHaveBeenCalled();
  gate.release();
  expect(await stale).toMatchObject({ name: "AbortError" });
  await choosing;
  expect(
    queries.filter((sql) => sql.includes('from "script_project_media"'))
  ).toEqual([]);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("drains asset-info query work even after the sibling path query rejects", async () => {
  const f = await fixture();
  const gate = hold();
  mocks.beforeQuery = async (sql) => {
    if (!sql.includes('from "assets"')) return;
    if (sql.includes('and "assets"."active"'))
      throw new Error("fixture path query failure");
    await gate.wait();
  };
  const stale = observe(f.invoke(ipc.cloudUploadAsset, preparedInput));
  await gate.entered;
  expect(await stale).toMatchObject({
    cause: new Error("fixture path query failure")
  });
  const { choosing, opened } = await f.startSwitch();
  expect(opened).not.toHaveBeenCalled();
  gate.release();
  await choosing;
  expect(mocks.put).not.toHaveBeenCalled();
});

it("drains a cache-miss sibling stat and does not enqueue an old encoder", async () => {
  const f = await fixture();
  await rm(videoCache(f.original));
  const gate = hold();
  mocks.beforeStat = async (file) => {
    if (file === path.join(f.original, "source.mp4")) await gate.wait();
  };
  const stale = observe(f.invoke(ipc.cloudPrepareUpload, preparedInput));
  await gate.entered;
  const { choosing, opened } = await f.startSwitch();
  expect(opened).not.toHaveBeenCalled();
  gate.release();
  expect(await stale).toMatchObject({ name: "AbortError" });
  await choosing;
  expect(mocks.spawn).not.toHaveBeenCalled();
  await expect(
    f.invoke(ipc.cloudPrepareUpload, preparedInput)
  ).resolves.toEqual({ sizeBytes: 15, encoded: false });
});

it("drains a delayed dispatch stat after cached preparation without opening a PUT", async () => {
  const f = await fixture();
  const gate = hold();
  let reads = 0;
  mocks.beforeStat = async (file) => {
    if (file === videoCache(f.original) && ++reads === 2) await gate.wait();
  };
  const stale = observe(f.invoke(ipc.cloudUploadPrepared, preparedInput));
  await gate.entered;
  const { choosing, opened } = await f.startSwitch();
  expect(opened).not.toHaveBeenCalled();
  gate.release();
  expect(await stale).toBeInstanceOf(Error);
  await choosing;
  expect(mocks.put).not.toHaveBeenCalled();
});

it("waits for video encoder close, keeps the old valid cache and refuses the queued encode", async () => {
  const f = await fixture();
  const { child, started } = mockChild();
  const force = { ...preparedInput, force: true };
  const current = observe(f.invoke(ipc.cloudPrepareUpload, force));
  const temporary = (await started).at(-1)!;
  await writeFile(temporary, "partial encode");
  const root = vi.spyOn(f.settings, "getLibraryRoot");
  const queued = observe(f.invoke(ipc.cloudPrepareUpload, force));
  await vi.waitFor(() => expect(root).toHaveBeenCalledOnce());
  await flush();
  const { choosing, opened } = await f.startSwitch();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("exit", 1);
  child.emit("error", new Error("local fixture encoder error"));
  await flush();
  expect(opened).not.toHaveBeenCalled();
  await expect(readFile(temporary, "utf8")).resolves.toBe("partial encode");
  child.emit("close", 1);
  await choosing;
  expect(await current).toBeInstanceOf(Error);
  expect(await queued).toMatchObject({ name: "AbortError" });
  expect(mocks.spawn).toHaveBeenCalledOnce();
  await expect(readFile(videoCache(f.original), "utf8")).resolves.toBe(
    "encoded video 0"
  );
  await expect(readdir(path.dirname(temporary))).resolves.toEqual([
    path.basename(videoCache(f.original))
  ]);
  await expect(
    f.invoke(ipc.cloudPrepareUpload, preparedInput)
  ).resolves.toMatchObject({ encoded: false });
});

it("kills image conversion, drains its close, and preserves original script media and URL", async () => {
  const f = await fixture();
  const { child, started } = mockChild();
  const stale = observe(f.invoke(ipc.cloudUploadAsset, scriptInput));
  const args = await started;
  expect(args).toContain(path.join(f.original, "script-projects/fixture.webp"));
  const temporary = args.at(-1)!;
  await writeFile(temporary, "partial png");
  const { choosing, opened } = await f.startSwitch();
  child.emit("exit", 1);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  await flush();
  expect(opened).not.toHaveBeenCalled();
  child.emit("close", 1);
  expect(await stale).toMatchObject({ name: "AbortError" });
  await choosing;
  await expect(readdir(path.dirname(imageCache(f.original)))).resolves.toEqual(
    []
  );
  await expect(
    readFile(path.join(f.original, "script-projects/fixture.webp"), "utf8")
  ).resolves.toBe("image 0");
  expect(await manager.get().select().from(scriptProjectMedia)).toMatchObject([
    { id: "script-image", sourceUrl: remoteUrl }
  ]);
  expect(mocks.put).not.toHaveBeenCalled();
});

it("owns the account-free asset-info probe through child close", async () => {
  const f = await fixture();
  await f.settings.setAppMode("offline");
  const { child, started } = mockChild();
  const stale = observe(f.invoke(ipc.cloudAssetInfo, scriptInput.assetId));
  expect(await started).toContain(
    path.join(f.original, "script-projects/fixture.webp")
  );
  const { choosing, opened } = await f.startSwitch();
  child.stderr.emit("data", Buffer.from("Stream #0:0: Video: webp, 32x16"));
  child.emit("exit", 1);
  await flush();
  expect(opened).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", 1);
  await choosing;
  expect(await stale).toMatchObject({ name: "AbortError" });
  await expect(f.invoke(ipc.cloudAssetInfo, "video")).resolves.toMatchObject({
    name: "Video 1"
  });
});

it("drains the opened video source file and early successful response body before replacement", async () => {
  const f = await fixture();
  const fileClose = hold();
  mocks.beforeFileClose = async (file) => {
    expect(file).toBe(videoCache(f.original));
    await fileClose.wait();
  };
  const put = mockPut();
  put.requestClose.release();
  const stale = observe(f.invoke(ipc.cloudUploadPrepared, preparedInput));
  await Promise.all([put.sent, fileClose.entered]);
  expect(put.text()).toBe("encoded video 0");
  expect(f.event.sender.send).toHaveBeenCalledWith(ipc.cloudUploadProgress, {
    assetId: "video",
    fraction: 1
  });
  const { choosing, opened } = await f.startSwitch();
  await put.bodyClose.entered;
  expect(opened).not.toHaveBeenCalled();
  put.bodyClose.release();
  await flush();
  expect(opened).not.toHaveBeenCalled();
  fileClose.release();
  expect(await stale).toBeInstanceOf(Error);
  await choosing;
  mocks.beforeFileClose = null;
  f.event.sender.send.mockClear();
  const next = mockPut();
  next.requestClose.release();
  next.bodyClose.release();
  next.body.push(null);
  await f.invoke(ipc.cloudUploadPrepared, preparedInput);
  expect(next.text()).toBe("encoded video 1");
  expect(f.event.sender.send).toHaveBeenCalledExactlyOnceWith(
    ipc.cloudUploadProgress,
    { assetId: "video", fraction: 1 }
  );
});

it("does not acknowledge a successful PUT at headers or body EOF alone", async () => {
  const f = await fixture();
  const put = mockPut();
  put.requestClose.release();
  let settled = false;
  const uploading = f.invoke(ipc.cloudUploadBytes, byteInput).then(() => {
    settled = true;
  });
  await put.sent;
  await flush();
  expect(settled).toBe(false);
  put.body.push(null);
  await put.bodyClose.entered;
  await flush();
  expect(settled).toBe(false);
  put.bodyClose.release();
  await uploading;
  expect(settled).toBe(true);
});

it("honors byte cancellation while permission is still pending", async () => {
  const f = await fixture();
  const gate = hold();
  vi.spyOn(f.settings, "getAppMode").mockImplementationOnce(async () => {
    await gate.wait();
    return "cloud";
  });
  const upload = observe(f.invoke(ipc.cloudUploadBytes, byteInput));
  await gate.entered;
  await f.invoke(ipc.cloudCancelUploadBytes, byteInput.uploadId);
  gate.release();
  expect(await upload).toMatchObject({ name: "AbortError" });
  expect(mocks.put).not.toHaveBeenCalled();
});

it("acknowledges cancellation only after a late response and the request both close", async () => {
  const f = await fixture();
  const put = mockPut({ lateHeaders: true });
  const pending = observe(f.invoke(ipc.cloudUploadBytes, byteInput));
  await put.sent;
  await f.settings.clearAppMode();
  let ack = false;
  const cancellation = f
    .invoke(ipc.cloudCancelUploadBytes, byteInput.uploadId)
    .then(() => {
      ack = true;
    });
  await put.requestClose.entered;
  await put.deliverResponse();
  await put.bodyClose.entered;
  put.requestClose.release();
  await flush();
  expect(ack).toBe(false);
  put.bodyClose.release();
  await cancellation;
  expect(await pending).toMatchObject({ message: "The upload was cancelled" });
});

it("drains both current and superseded transfers for the same ID but isolates trusted senders", async () => {
  const f = await fixture();
  const first = mockPut();
  const a = observe(f.invoke(ipc.cloudUploadBytes, byteInput));
  await first.sent;
  const second = mockPut();
  const b = observe(f.invoke(ipc.cloudUploadBytes, byteInput));
  await second.sent;
  await first.bodyClose.entered;
  await f.invoke(ipc.cloudCancelUploadBytes, byteInput.uploadId, renderer());
  expect(second.body.destroyed).toBe(false);
  let ack = false;
  const cancel = f
    .invoke(ipc.cloudCancelUploadBytes, byteInput.uploadId)
    .then(() => {
      ack = true;
    });
  await second.bodyClose.entered;
  first.requestClose.release();
  second.requestClose.release();
  second.bodyClose.release();
  expect(await b).toBeInstanceOf(Error);
  expect(ack).toBe(false);
  first.bodyClose.release();
  await cancel;
  expect(await a).toBeInstanceOf(Error);
});

it("cannot delete the replacement byte entry from an old permission/finally continuation", async () => {
  const f = await fixture();
  const gate = hold();
  vi.spyOn(f.settings, "getAppMode").mockImplementationOnce(async () => {
    await gate.wait();
    return "cloud";
  });
  const old = observe(f.invoke(ipc.cloudUploadBytes, byteInput));
  await gate.entered;
  await f.choose();
  const put = mockPut();
  put.requestClose.release();
  const fresh = observe(f.invoke(ipc.cloudUploadBytes, byteInput));
  await put.sent;
  gate.release();
  expect(await old).toMatchObject({ name: "AbortError" });
  expect(put.body.destroyed).toBe(false);
  const cancellation = f.invoke(ipc.cloudCancelUploadBytes, byteInput.uploadId);
  await put.bodyClose.entered;
  put.bodyClose.release();
  await cancellation;
  expect(await fresh).toBeInstanceOf(Error);
  expect(mocks.put).toHaveBeenCalledOnce();
});

it.each(["open", "settings"] as const)(
  "leaves all six routes suspended on failed %s",
  async (failure) => {
    const f = await fixture();
    const gate = hold();
    if (failure === "open")
      vi.spyOn(manager, "open").mockImplementationOnce(async () => {
        await gate.wait();
        throw new Error("failed open");
      });
    else
      vi.spyOn(f.settings, "setLibraryRoot").mockImplementationOnce(
        async () => {
          await gate.wait();
          throw new Error("failed settings");
        }
      );
    const switched = observe(f.choose());
    await gate.entered;
    const policy = vi.spyOn(f.settings, "getAppMode");
    const root = vi.spyOn(f.settings, "getLibraryRoot");
    const assertSuspended = async () => {
      for (const [channel, input] of allRequests) {
        await expect(f.invoke(channel, input)).rejects.toMatchObject({
          name: "AbortError"
        });
      }
    };
    await assertSuspended();
    gate.release();
    expect(await switched).toMatchObject({ message: `failed ${failure}` });
    await assertSuspended();
    expect(policy).not.toHaveBeenCalled();
    expect(root).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  }
);

it("uploads only the selected library's converted image after reset", async () => {
  const f = await fixture();
  await f.choose();
  const cached = imageCache(f.replacement);
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, "converted replacement image");
  const put = mockPut();
  put.body.push(null);
  put.bodyClose.release();
  put.requestClose.release();
  await f.invoke(ipc.cloudUploadAsset, scriptInput);
  expect(put.text()).toBe("converted replacement image");
  expect(mocks.put).toHaveBeenCalledWith(
    new URL(presignedUrl),
    expect.objectContaining({
      headers: { "content-type": "image/png", "content-length": 27 }
    }),
    expect.any(Function)
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
  await expect(stat(imageCache(f.original))).rejects.toMatchObject({
    code: "ENOENT"
  });
});

it("resets upload routes only after the replacement settings are persisted", async () => {
  const f = await fixture();
  const gate = hold();
  const persist = f.settings.setLibraryRoot.bind(f.settings);
  vi.spyOn(f.settings, "setLibraryRoot").mockImplementationOnce(
    async (root) => {
      await gate.wait();
      await persist(root);
    }
  );
  const choosing = f.choose();
  await gate.entered;
  await expect(f.invoke(ipc.cloudAssetInfo, "video")).rejects.toMatchObject({
    name: "AbortError"
  });
  gate.release();
  await choosing;
  await expect(f.invoke(ipc.cloudAssetInfo, "video")).resolves.toMatchObject({
    name: "Video 1"
  });
  await expect(f.settings.getLibraryRoot()).resolves.toBe(f.replacement);
});
