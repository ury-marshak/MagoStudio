import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { protocol } from "electron";

import { resolveCloudConfig } from "../shared/cloudConfig";

import { requireCloudAccount } from "./cloud/requireCloudAccount";
import { cloudStorageProtocolResponse } from "./cloudStorage/cloudStorageProtocolResponse";
import { ProjectRepository } from "./database/projectRepository";
import { ScriptProjectSnapshotRepository } from "./database/scriptProjectSnapshotRepository";
import { clearLibraryIssue, reportLibraryIssue } from "./libraryHealth";
import { LibrarySettings } from "./librarySettings";
import { LibraryWorkSession } from "./libraryWorkSession";
import { libraryMediaStream } from "./media/libraryMediaStream";
import type { ProfileIoDrain } from "./providers/profileIoDrain";

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const CLOUD_STORAGE_PROTOCOL_HOST = "cloud-storage";

const mediaContentType = (filePath: string): string => {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
};

const parseByteRange = (
  value: string | null,
  size: number
): { start: number; end: number } | null => {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
};

const mediaFileResponse = async (
  request: Request,
  filePath: string,
  work: LibraryWorkSession<undefined>
): Promise<Response> => {
  const fileStats = await work.boundary(() => stat(filePath));
  request.signal.throwIfAborted();
  if (!fileStats.isFile()) return new Response("Not found", { status: 404 });

  const rangeHeader = request.headers.get("range");
  const range = parseByteRange(rangeHeader, fileStats.size);
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${fileStats.size}` }
    });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? fileStats.size - 1;
  const contentLength = end - start + 1;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Accept-Ranges, Content-Length, Content-Range",
    // IDs may be reused in another library; do not let Chromium reuse old bytes.
    "Cache-Control": "no-store",
    "Content-Length": String(contentLength),
    "Content-Type": mediaContentType(filePath)
  });
  if (range) {
    headers.set("Content-Range", `bytes ${start}-${end}/${fileStats.size}`);
  }
  if (request.method === "HEAD" || fileStats.size === 0) {
    return new Response(null, {
      status: range ? HTTP_PARTIAL_CONTENT : HTTP_OK,
      headers
    });
  }

  const body = Readable.toWeb(
    createReadStream(filePath, { start, end })
  ) as ReadableStream<Uint8Array>;
  return new Response(libraryMediaStream(body, work, request.signal), {
    status: range ? HTTP_PARTIAL_CONTENT : HTTP_OK,
    headers
  });
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mago-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

export const registerMediaProtocol = (
  repository: ProjectRepository,
  scriptProjects: ScriptProjectSnapshotRepository,
  settings: LibrarySettings,
  work = new LibraryWorkSession(() => undefined),
  captureAccountProfile?: () => AbortSignal,
  profileIo?: ProfileIoDrain
): void => {
  const cloudStorageHosts = resolveCloudConfig().cloudStorageHosts;
  const projects = work.guard(repository);
  const scripts = work.guard(scriptProjects);
  protocol.handle("mago-media", async (originalRequest) => {
    let signal: AbortSignal | undefined;
    try {
      const cloud =
        new URL(originalRequest.url).hostname === CLOUD_STORAGE_PROTOCOL_HOST;
      const profile = cloud ? captureAccountProfile?.() : undefined;
      signal = AbortSignal.any([
        work.capture(),
        originalRequest.signal,
        ...(profile ? [profile] : [])
      ]);
      const request = new Request(originalRequest, { signal });
      return await work.run(async () => {
        signal!.throwIfAborted();
        const url = new URL(request.url);
        const kind = url.hostname;
        if (kind === CLOUD_STORAGE_PROTOCOL_HOST) {
          const handle = () =>
            work.boundary(async () => {
              const upstream = await cloudStorageProtocolResponse(
                request,
                cloudStorageHosts,
                undefined,
                () => requireCloudAccount(settings, profile)
              );
              // Even an abort-ignoring headers callback must release its body.
              if (request.signal.aborted) {
                await upstream.body?.cancel(request.signal.reason);
                request.signal.throwIfAborted();
              }
              return new Response(
                upstream.body
                  ? libraryMediaStream(
                      upstream.body,
                      work,
                      request.signal,
                      (closed) => {
                        void profileIo
                          ?.run(profile, () => closed)
                          .catch(() => {});
                      }
                    )
                  : null,
                { status: upstream.status, headers: upstream.headers }
              );
            });
          return profileIo ? profileIo.run(profile, handle) : handle();
        }
        if (
          kind !== "asset" &&
          kind !== "thumbnail" &&
          kind !== "script-project" &&
          kind !== "script-project-thumbnail"
        ) {
          return new Response("Not found", { status: 404 });
        }
        const id = decodeURIComponent(url.pathname.slice(1));
        if (!id || id.includes("/") || id.includes("\\")) {
          return new Response("Not found", { status: 404 });
        }
        const filePath =
          kind === "script-project"
            ? await scripts.resolveMediaPath(id)
            : kind === "script-project-thumbnail"
              ? await scripts.resolveThumbnailMediaPath(id, work.signal)
              : await projects.resolveMediaPath(kind, id);
        request.signal.throwIfAborted();
        if (!filePath) return new Response("Not found", { status: 404 });
        const response = await mediaFileResponse(request, filePath, work);
        request.signal.throwIfAborted();
        clearLibraryIssue(`media:${request.url}`);
        return response;
      });
    } catch (error) {
      // A stale request is not evidence about the replacement library's health.
      if (signal && !signal.aborted) {
        reportLibraryIssue({
          id: `media:${originalRequest.url}`,
          kind: "asset",
          message: `Media unavailable: ${originalRequest.url}. ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return new Response("Not found", { status: 404 });
    }
  });
};
