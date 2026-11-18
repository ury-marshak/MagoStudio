import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: "",
  request: vi.fn(),
  beforeStat: null as null | (() => Promise<void>)
}));
vi.mock("electron", () => ({ app: { getPath: () => mocks.profile } }));
vi.mock("node:https", async (original) => {
  const https = await original<typeof import("node:https")>();
  return {
    ...https,
    default: { ...https, request: mocks.request },
    request: mocks.request
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      await mocks.beforeStat?.();
      return fs.stat(...args);
    }
  };
});

import { LibrarySettings } from "../librarySettings";

import { requireCloudAccount } from "./requireCloudAccount";
import { uploadCachePath } from "./uploadEncode";
import {
  uploadBytesToPresignedUrl,
  uploadFileToPresignedUrl
} from "./uploadFile";
import { UploadService } from "./uploadService";

let settings: LibrarySettings;
let filePath: string;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.beforeStat = null;
  mocks.profile = await mkdtemp(path.join(tmpdir(), "mago-upload-policy-"));
  settings = new LibrarySettings();
  filePath = path.join(mocks.profile, "fixture.mp4");
  await writeFile(filePath, "fixture media");
  mocks.request.mockImplementation(() => {
    throw new Error("unexpected HTTPS dispatch");
  });
});
afterEach(async () => {
  await rm(mocks.profile, { recursive: true, force: true });
});
const assertAccess = () => requireCloudAccount(settings);
const uploadInput = () => ({
  filePath,
  presignedUrl: "https://upload.invalid/presigned",
  contentType: "video/mp4",
  assertAccess
});

test("file upload refuses at the dispatch boundary after a delayed stat and sign-out", async () => {
  await settings.setAppMode("cloud");
  let release!: () => void;
  mocks.beforeStat = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = uploadFileToPresignedUrl(uploadInput());
  const rejected = expect(pending).rejects.toThrow("explicit cloud account");
  await vi.waitFor(() => expect(release).toBeDefined());
  await settings.clearAppMode();
  release();
  await rejected;
  expect(mocks.request).not.toHaveBeenCalled();
});

test("byte uploads enforce main account permission before creating HTTPS traffic", async () => {
  await expect(
    uploadBytesToPresignedUrl({
      ...uploadInput(),
      bytes: Buffer.from("fixture")
    })
  ).rejects.toThrow("explicit cloud account");
  expect(mocks.request).not.toHaveBeenCalled();
});

test("the prepared video upload service forwards its dispatch policy", async () => {
  const uploads = new UploadService(async () => mocks.profile);
  await expect(uploads.upload(uploadInput())).rejects.toThrow(
    "explicit cloud account"
  );
  expect(mocks.request).not.toHaveBeenCalled();
});

test("deliberate cloud choice permits a streamed file PUT, with exact fixture bytes", async () => {
  await settings.setAppMode("cloud");
  const chunks: Buffer[] = [];
  mocks.request.mockImplementation(
    (_url, _options, onResponse) =>
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          onResponse(Object.assign(Readable.from([]), { statusCode: 200 }));
          callback();
        }
      })
  );
  await uploadFileToPresignedUrl(uploadInput());
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
    new URL("https://upload.invalid/presigned"),
    expect.objectContaining({
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": 13 }
    }),
    expect.any(Function)
  );
  expect(Buffer.concat(chunks).toString()).toBe("fixture media");
});

test("account policy does not disable ordinary local upload-cache preparation", async () => {
  const cached = path.join(
    mocks.profile,
    uploadCachePath({ assetId: "asset" })
  );
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, "encoded fixture");
  const uploads = new UploadService(async () => mocks.profile);
  expect(
    await uploads.prepare({ assetId: "asset", sourcePath: filePath })
  ).toMatchObject({ filePath: cached, encoded: false });
  expect(mocks.request).not.toHaveBeenCalled();
});

test.each([uploadFileToPresignedUrl, uploadBytesToPresignedUrl])(
  "%s refuses a PUT after cancellation during the dispatch permission wait",
  async (upload) => {
    const controller = new AbortController();
    let release!: () => void;
    const pending = upload({
      ...uploadInput(),
      bytes: Buffer.from("fixture"),
      signal: controller.signal,
      assertAccess: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(release).toBeDefined());
    controller.abort();
    release();
    await rejected;
    expect(mocks.request).not.toHaveBeenCalled();
  }
);
