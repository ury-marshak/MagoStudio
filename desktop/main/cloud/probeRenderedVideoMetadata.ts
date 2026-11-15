import { spawn } from "node:child_process";

import ffmpegPath from "ffmpeg-static";

import {
  parseRenderedVideoMetadata,
  RenderedVideoMetadata
} from "./parseRenderedVideoMetadata";

const FFMPEG_PROBE_TIMEOUT_MS = 60_000;
const KEPT_FFMPEG_LOG_LENGTH = 20_000;
const FRAMECRC_HEADER_LINE_PREFIX = "#";
const LINE_BREAK = "\n";

const ffmpegExecutablePath = (): string | null =>
  ffmpegPath ? ffmpegPath.replace("app.asar", "app.asar.unpacked") : null;

const buildPacketListingArgs = (filePath: string): string[] => [
  "-hide_banner",
  "-nostdin",
  "-i",
  filePath,
  "-map",
  "0:v:0",
  "-c",
  "copy",
  "-f",
  "framecrc",
  "-"
];

const createFramecrcPacketLineCounter = () => {
  let packetLineCount = 0;
  let isAtLineStart = true;
  return {
    read: (text: string) => {
      for (const character of text) {
        if (isAtLineStart && character !== FRAMECRC_HEADER_LINE_PREFIX)
          packetLineCount += 1;
        isAtLineStart = character === LINE_BREAK;
      }
    },
    count: () => packetLineCount
  };
};

export const probeRenderedVideoMetadata = (
  filePath: string,
  signal?: AbortSignal
): Promise<RenderedVideoMetadata | null> => {
  if (signal?.aborted) return Promise.resolve(null);
  const executablePath = ffmpegExecutablePath();
  if (!executablePath) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(executablePath, buildPacketListingArgs(filePath), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const packetLineCounter = createFramecrcPacketLineCounter();
    let ffmpegLog = "";
    let failed = false;
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const didListEveryPacket = !failed && !signal?.aborted && exitCode === 0;
      resolve(
        didListEveryPacket
          ? parseRenderedVideoMetadata({
              videoPacketCount: packetLineCounter.count(),
              ffmpegLog
            })
          : null
      );
    };
    const timer = setTimeout(abort, FFMPEG_PROBE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", packetLineCounter.read);
    child.stderr.on("data", (chunk: Buffer) => {
      ffmpegLog = `${ffmpegLog}${chunk.toString()}`.slice(
        0,
        KEPT_FFMPEG_LOG_LENGTH
      );
    });
    // Even spawn/abort errors are followed by close; retain ownership of stdio.
    child.once("error", () => {
      failed = true;
    });
    child.once("close", finish);
  });
};
