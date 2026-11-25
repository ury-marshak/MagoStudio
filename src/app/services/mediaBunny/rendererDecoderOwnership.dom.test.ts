import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  type RendererLibraryWork,
  RendererLibrarySession
} from "@/platform/rendererLibraryWork";

import { detectVideoHasAudioTrack } from "./detectVideoHasAudioTrack";
import { extractFrameFromVideo, generateFilmstrip } from "./frameExtraction";
import { getMediabunny } from "./lazyLoad";

vi.mock("./lazyLoad", () => ({ getMediabunny: vi.fn() }));
const load = vi.mocked(getMediabunny);
const audioTrack = vi.fn();
const dispose = vi.fn();
const media = {
  ALL_FORMATS: [],
  UrlSource: vi.fn(function () {}),
  BlobSource: vi.fn(function () {}),
  Input: vi.fn(function () {
    return { getPrimaryAudioTrack: audioTrack, dispose };
  })
};
const decoder = media as unknown as Awaited<ReturnType<typeof getMediabunny>>;
const source = "mago-media://asset/reused";

beforeEach(() => {
  vi.resetAllMocks();
  load.mockResolvedValue(decoder);
});
afterEach(() => vi.unstubAllGlobals());

const readers: Array<
  [string, (url: string, work: RendererLibraryWork) => Promise<unknown>]
> = [
  ["audio", detectVideoHasAudioTrack],
  [
    "frame",
    (url, work) =>
      extractFrameFromVideo({ videoSource: url, frameNumber: 0, fps: 24 }, work)
  ],
  [
    "filmstrip",
    (url, work) => generateFilmstrip(url, { width: 100, fps: 24 }, work)
  ]
];
it.each(readers)(
  "does not open a %s decoder after its lazy import crosses a switch",
  async (_name, read) => {
    const library = new RendererLibrarySession();
    const wait = Promise.withResolvers<typeof decoder>();
    load.mockReturnValueOnce(wait.promise);
    const pending = read(source, library.capture());
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await library.suspend();
    library.reset();
    wait.resolve(decoder);
    await rejected;
    expect(media.UrlSource).not.toHaveBeenCalled();
    expect(media.Input).not.toHaveBeenCalled();
  }
);

it("disposes a pending audio Input synchronously on retirement and ignores a late success", async () => {
  const library = new RendererLibrarySession();
  const wait = Promise.withResolvers<object>();
  audioTrack.mockReturnValueOnce(wait.promise);
  const pending = detectVideoHasAudioTrack(source, library.capture());
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError"
  });
  await vi.waitFor(() => expect(audioTrack).toHaveBeenCalledOnce());
  const suspended = library.suspend();
  expect(dispose).toHaveBeenCalledOnce();
  await suspended;
  await rejected;
  library.reset();
  wait.resolve({});
  audioTrack.mockResolvedValueOnce(null);
  await expect(
    detectVideoHasAudioTrack(source, library.capture())
  ).resolves.toBe(false);
  expect(dispose).toHaveBeenCalledTimes(2);
});

it("cancels an in-flight blob body without opening a retired BlobSource", async () => {
  const library = new RendererLibrarySession();
  const pulling = Promise.withResolvers<void>();
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull: () => {
              pulling.resolve();
              return new Promise(() => {});
            },
            cancel
          },
          { highWaterMark: 0 }
        )
      )
    )
  );
  const pending = detectVideoHasAudioTrack("blob:local", library.capture());
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError"
  });
  await pulling.promise;
  await library.suspend();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(media.BlobSource).not.toHaveBeenCalled();
  expect(media.Input).not.toHaveBeenCalled();
});
