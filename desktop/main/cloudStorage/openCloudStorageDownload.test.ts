import { text } from "node:stream/consumers";

import { describe, expect, it, vi } from "vitest";

import {
  openCloudStorageDownload,
  withCloudStorageDownload
} from "./openCloudStorageDownload";

const ALLOWED_HOSTS = [
  "mago-s3-prod.s3.amazonaws.com",
  "mago-s3-prod.s3.eu-north-1.amazonaws.com"
];
const OBJECT_URL = "https://mago-s3-prod.s3.amazonaws.com/a/video.mp4?sig=1";

describe("openCloudStorageDownload", () => {
  it("streams an allowed object with its response headers", async () => {
    const download = await openCloudStorageDownload({
      url: OBJECT_URL,
      allowedHosts: ALLOWED_HOSTS,
      fetchFromCloudStorage: vi.fn().mockResolvedValue(
        new Response("video-bytes", {
          status: 200,
          headers: { "content-type": "video/mp4" }
        })
      )
    });

    expect(download.headers.get("content-type")).toBe("video/mp4");
    expect(await text(download.body)).toBe("video-bytes");
  });

  it("rejects a status the bucket did not serve successfully", async () => {
    await expect(
      openCloudStorageDownload({
        url: OBJECT_URL,
        allowedHosts: ALLOWED_HOSTS,
        fetchFromCloudStorage: vi
          .fn()
          .mockResolvedValue(new Response("expired", { status: 403 }))
      })
    ).rejects.toThrow("(403)");
  });

  it("never contacts a host outside the allowlist", async () => {
    const fetchFromCloudStorage = vi.fn();

    await expect(
      openCloudStorageDownload({
        url: "https://169.254.169.254/latest/meta-data",
        allowedHosts: ALLOWED_HOSTS,
        fetchFromCloudStorage
      })
    ).rejects.toThrow("not Mago cloud storage");
    expect(fetchFromCloudStorage).not.toHaveBeenCalled();
  });

  it("refuses a redirect that leaves the allowlist", async () => {
    const fetchFromCloudStorage = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" }
      })
    );

    await expect(
      openCloudStorageDownload({
        url: OBJECT_URL,
        allowedHosts: ALLOWED_HOSTS,
        fetchFromCloudStorage
      })
    ).rejects.toThrow("not Mago cloud storage");
    expect(fetchFromCloudStorage).toHaveBeenCalledTimes(1);
  });

  it("forwards the abort signal to the request", async () => {
    const controller = new AbortController();
    const fetchFromCloudStorage = vi
      .fn()
      .mockResolvedValue(new Response("bytes", { status: 200 }));

    await openCloudStorageDownload({
      url: OBJECT_URL,
      allowedHosts: ALLOWED_HOSTS,
      fetchFromCloudStorage,
      signal: controller.signal
    });

    expect(fetchFromCloudStorage.mock.calls[0]![1]).toMatchObject({
      signal: controller.signal
    });
  });

  it("cancels a pending read without another chunk and waits for transport cleanup", async () => {
    const profile = new AbortController();
    let incomplete: ReadableStreamDefaultController<Uint8Array> | undefined;
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const canceled = vi.fn(() => {
      incomplete = undefined;
      return cleanup;
    });
    let reading!: () => void;
    const readingPartialBody = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            incomplete = controller;
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          pull() {
            reading();
          },
          cancel: canceled
        },
        { highWaterMark: 0 }
      )
    );
    const released = vi.fn();
    const pending = withCloudStorageDownload(
      {
        url: OBJECT_URL,
        allowedHosts: ALLOWED_HOSTS,
        fetchFromCloudStorage: vi.fn().mockResolvedValue(response),
        signal: profile.signal
      },
      ({ body }) => text(body)
    ).finally(released);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    try {
      await readingPartialBody;
      profile.abort();
      await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce(), {
        timeout: 250
      });
      expect(released).not.toHaveBeenCalled();
    } finally {
      incomplete?.close();
      release();
      await Promise.allSettled([rejected]);
    }
    await rejected;
  });
});
