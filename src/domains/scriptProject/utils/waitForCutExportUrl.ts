import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { getProjectCut } from "../api/getProjectCut";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100;

const pollDelay = (durationMs: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/** The exported MP4's URL, once the worker has uploaded it.
 *
 * The stitch runs in the agent worker, so the dispatch returns before the file exists. Polls
 * the cut rather than the plan, because the URL is what the download needs and it appears on
 * the cut the moment the upload lands. Returns null if it never does, which sends the caller
 * to the per-shot fallback rather than leaving the button spinning. */
export const waitForCutExportUrl = async ({
  projectId,
  planId,
  work = rendererLibrary.capture(),
  sleep = pollDelay
}: {
  projectId: string;
  planId: string;
  work?: RendererLibraryWork;
  sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<string | null> => {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    work.check();
    await sleep(POLL_INTERVAL_MS, work.signal);
    work.check();

    const cut = await getProjectCut(projectId, { preferCache: false }, work);
    work.check();
    const isThisExport = cut.export?.plan_id === planId;

    if (isThisExport && cut.export?.url) return cut.export.url;
  }

  return null;
};
