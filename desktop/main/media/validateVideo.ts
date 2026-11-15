import ffmpegPath from "ffmpeg-static";

import { runLibraryFfmpeg } from "./runLibraryFfmpeg";

export const validateVideo = async (
  filename: string,
  signal?: AbortSignal
): Promise<void> => {
  if (!ffmpegPath) throw new Error("The video validator is unavailable");
  await runLibraryFfmpeg(
    ffmpegPath.replace("app.asar", "app.asar.unpacked"),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-xerror",
      "-i",
      filename,
      // Decode every frame: copying packets can accept unreadable media data.
      "-map",
      "0:v:0",
      "-f",
      "null",
      "-"
    ],
    signal,
    "The interrupted video is incomplete or unreadable"
  );
};
