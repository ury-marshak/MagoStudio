import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ComfyLaunchedProcess } from "../../shared/contracts";
import type { LibrarySettings } from "../librarySettings";
import { resolveAppFolder } from "../resolveAppFolder";

import { extractComfyStartupFailureReason } from "./extractComfyStartupFailureReason";
import { findListeningProcessId } from "./findListeningProcessId";
import { killProcessTree } from "./killProcessTree";
import { normalizeComfyEndpoint } from "./normalizeComfyEndpoint";
import { resolveEndpointPort } from "./resolveEndpointPort";

const availabilityTimeoutMs = 3_000;
const processExitTimeoutMs = 5_000;
const endpointShutdownTimeoutMs = 15_000;
const endpointShutdownPollMs = 500;
const comfyOutputTailBytes = 65_536;

const checkEndpoint = async (endpoint: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(availabilityTimeoutMs);
  const response = await fetch(endpoint + "/system_stats", {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  }).catch(() => null);
  void response?.body?.cancel().catch(() => {});
  signal?.throwIfAborted();
  return response?.ok === true;
};

export class ComfyLauncher {
  private process: {
    child: ChildProcess | null;
    endpoint: string;
    signal: AbortSignal | undefined;
    exit: {
      exitCode: number | null;
      reportedFailureReason: string | null;
    } | null;
    release: () => void;
  } | null = null;
  private starting: {
    signal: AbortSignal | undefined;
    endpoint: string | undefined;
    promise: Promise<void>;
  } | null = null;
  private spawnCleanup: {
    signal: AbortSignal | undefined;
    done: Promise<void>;
  } | null = null;

  constructor(
    private readonly settings: Pick<
      LibrarySettings,
      "getLocalModelsRoot" | "getComfyEndpoint" | "getInferredComfyInstall"
    >,
    private readonly comfyOutputLogPath: string
  ) {}

  private async readComfyOutputTail(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const comfyOutputLog = await open(this.comfyOutputLogPath, "r");
    try {
      signal?.throwIfAborted();
      const { size: comfyOutputLogSize } = await comfyOutputLog.stat();
      signal?.throwIfAborted();
      const tailLength = Math.min(comfyOutputLogSize, comfyOutputTailBytes);
      const { buffer, bytesRead } = await comfyOutputLog.read(
        Buffer.alloc(tailLength),
        0,
        tailLength,
        comfyOutputLogSize - tailLength
      );
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await comfyOutputLog.close();
    }
  }

  private async readReportedFailureReason(
    signal?: AbortSignal
  ): Promise<string | null> {
    try {
      return extractComfyStartupFailureReason(
        await this.readComfyOutputTail(signal)
      );
    } catch {
      return null;
    }
  }

  private async resolveEndpoint(endpoint?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const value =
      endpoint ??
      normalizeComfyEndpoint(await this.settings.getComfyEndpoint());
    signal?.throwIfAborted();
    return value;
  }

  private async launchDirectory(
    endpoint?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    signal?.throwIfAborted();
    if (process.platform !== "win32") return null;
    const resolved = await this.resolveEndpoint(endpoint, signal);
    signal?.throwIfAborted();
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(resolved).hostname)
    )
      return null;
    const inferred = await this.settings.getInferredComfyInstall();
    signal?.throwIfAborted();
    const root = await this.settings.getLocalModelsRoot();
    signal?.throwIfAborted();
    const candidates: string[] = [];
    if (inferred?.endpoint === resolved && path.isAbsolute(inferred.directory))
      candidates.push(inferred.directory);
    if (root) {
      const base = resolveAppFolder(root);
      try {
        const marker = JSON.parse(
          await readFile(
            path.join(base, ".downloads", "engine-installed.json"),
            "utf8"
          )
        );
        if (
          typeof marker.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(marker.sha256)
        )
          candidates.push(path.join(base, "ComfyUI_windows_portable"));
      } catch {
        /* No completed engine installation. */
      }
    }
    signal?.throwIfAborted();
    for (const directory of candidates) {
      const files = await Promise.all(
        [
          "run_nvidia_gpu.bat",
          "python_embeded/python.exe",
          "ComfyUI/main.py"
        ].map((file) => stat(path.join(directory, file)).catch(() => null))
      );
      signal?.throwIfAborted();
      if (files.every((file) => file?.isFile())) return directory;
    }
    return null;
  }

  async canLaunch(endpoint?: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.getLaunchPath(endpoint, signal)) !== null;
  }

  async getLaunchPath(
    endpoint?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const directory = await this.launchDirectory(endpoint, signal);
    signal?.throwIfAborted();
    return directory ? path.join(directory, "run_nvidia_gpu.bat") : null;
  }

  launch(options?: {
    restartUnresponsiveProcess?: boolean;
    endpoint?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { endpoint, signal } = options ?? {};
    if (signal?.aborted) return Promise.reject(signal.reason);
    const starting = this.starting;
    if (
      starting &&
      starting.signal === signal &&
      starting.endpoint === endpoint
    )
      return starting.promise;
    const promise = this.start(
      options?.restartUnresponsiveProcess === true,
      endpoint,
      signal
    ).finally(() => {
      if (this.starting?.promise === promise) this.starting = null;
      signal?.throwIfAborted();
    });
    this.starting = { endpoint, signal, promise };
    return promise;
  }

  async restartLaunchedProcess(
    endpoint?: string,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.isLaunchedProcessRunning(endpoint, signal))
      throw new Error(
        "ComfyUI is no longer running from Mago. Launch it again to load the new node packs."
      );
    const resolved = await this.resolveEndpoint(endpoint, signal);
    signal?.throwIfAborted();
    await this.stopLaunchedProcess(resolved, signal);
    await this.waitUntilEndpointStopsAnswering(resolved, signal);
    await this.launchAfterRestart(resolved, signal);
  }

  async relaunchProcessStartedOutsideMago(
    endpoint?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const resolved = await this.resolveEndpoint(endpoint, signal);
    if (!(await this.canLaunch(resolved, signal)))
      throw new Error(
        "Mago doesn't know where this ComfyUI is installed. Restart it yourself to load the new node packs."
      );
    signal?.throwIfAborted();
    const processId = await findListeningProcessId(
      resolveEndpointPort(resolved)
    );
    signal?.throwIfAborted();
    if (processId === null)
      throw new Error(
        "Mago couldn't find the running ComfyUI process. Restart it yourself to load the new node packs."
      );
    await killProcessTree(processId);
    await this.waitUntilEndpointStopsAnswering(resolved, signal);
    await this.launchAfterRestart(resolved, signal);
  }

  private async launchAfterRestart(endpoint: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.launch({ endpoint, signal });
    signal?.throwIfAborted();
    if (!this.isLaunchedProcessRunning(endpoint, signal))
      throw new Error(
        "ComfyUI didn't start again. Launch it to load the new node packs."
      );
  }

  async waitUntilEndpointStopsAnswering(
    endpoint?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const resolved = await this.resolveEndpoint(endpoint, signal);
    const deadline = Date.now() + endpointShutdownTimeoutMs;
    while (Date.now() < deadline) {
      const answering = await checkEndpoint(resolved, signal);
      signal?.throwIfAborted();
      if (!answering) return;
      await delay(endpointShutdownPollMs, undefined, { signal });
    }
    signal?.throwIfAborted();
    throw new Error(
      "The previous ComfyUI is still answering. Close it, then launch ComfyUI again."
    );
  }

  private processFor(endpoint?: string, signal?: AbortSignal) {
    const tracked = this.process;
    return tracked &&
      tracked.signal === signal &&
      !signal?.aborted &&
      (endpoint === undefined || tracked.endpoint === endpoint)
      ? tracked
      : null;
  }

  isLaunchedProcessRunning(endpoint?: string, signal?: AbortSignal): boolean {
    return this.processFor(endpoint, signal)?.child?.exitCode === null;
  }

  getLaunchedProcess(
    endpoint?: string,
    signal?: AbortSignal
  ): ComfyLaunchedProcess | null {
    const tracked = this.processFor(endpoint, signal);
    if (tracked?.child?.exitCode === null) return { status: "running" };
    return tracked?.exit ? { status: "exited", ...tracked.exit } : null;
  }

  async drainLaunchCleanup(signal: AbortSignal): Promise<void> {
    const cleanup = this.spawnCleanup;
    if (cleanup?.signal === signal) await cleanup.done;
  }

  private async stopLaunchedProcess(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    const tracked = this.processFor(endpoint, signal);
    const child = tracked?.child;
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    tracked.release();
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
      child.once("exit", exited);
    });
    try {
      await killProcessTree(child.pid);
      await Promise.race([
        exit,
        delay(processExitTimeoutMs, undefined, { ref: false })
      ]);
    } finally {
      child.removeListener("exit", exited);
    }
    signal?.throwIfAborted();
  }

  private async start(
    restartUnresponsiveProcess: boolean,
    endpoint?: string,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (
      !restartUnresponsiveProcess &&
      this.isLaunchedProcessRunning(endpoint, signal)
    )
      return;
    if (process.platform !== "win32")
      throw new Error("Launching the bundled ComfyUI requires Windows.");
    const resolved = await this.resolveEndpoint(endpoint, signal);
    if (await checkEndpoint(resolved, signal)) {
      signal?.throwIfAborted();
      return;
    }
    signal?.throwIfAborted();
    if (this.isLaunchedProcessRunning(resolved, signal))
      await this.stopLaunchedProcess(resolved, signal);
    const directory = await this.launchDirectory(resolved, signal);
    signal?.throwIfAborted();
    if (!directory)
      throw new Error(
        "ComfyUI launcher was not found. Complete setup or check your local ComfyUI installation first."
      );
    await mkdir(path.dirname(this.comfyOutputLogPath), { recursive: true });
    // Do not let a late log open from the retired attempt truncate a new log.
    while (this.spawnCleanup !== null) {
      signal?.throwIfAborted();
      await this.spawnCleanup.done;
    }
    signal?.throwIfAborted();
    let cleanedUp!: () => void;
    const done = new Promise<void>((resolve) => {
      cleanedUp = resolve;
    });
    this.spawnCleanup = { signal, done };
    try {
      const comfyOutputLog = await open(this.comfyOutputLogPath, "w");
      try {
        signal?.throwIfAborted();
        await this.spawn(directory, comfyOutputLog.fd, resolved, signal);
      } finally {
        await comfyOutputLog.close();
      }
    } finally {
      this.spawnCleanup = null;
      cleanedUp();
    }
    signal?.throwIfAborted();
  }

  private async spawn(
    directory: string,
    fd: number,
    endpoint: string,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    const child = spawn("cmd.exe", ["/d", "/s", "/c", "run_nvidia_gpu.bat"], {
      cwd: directory,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true
    });
    const tracked: NonNullable<ComfyLauncher["process"]> = {
      child,
      endpoint,
      signal,
      exit: null,
      release: () => {
        signal?.removeEventListener("abort", tracked.release);
        child.removeListener("exit", onExit);
        if (this.process === tracked) this.process = null;
      }
    };
    this.process?.release();
    this.process = tracked;
    signal?.addEventListener("abort", tracked.release, { once: true });
    const onExit = (exitCode: number | null) => {
      if (this.process !== tracked) return;
      tracked.child = null;
      void this.readReportedFailureReason(signal).then(
        (reportedFailureReason) => {
          if (this.process === tracked && !signal?.aborted)
            tracked.exit = { exitCode, reportedFailureReason };
        }
      );
    };
    child.once("exit", onExit);
    // On retirement abandon the spawn wait, but still unref a late child and
    // consume its error event. The process is already detached from Mago.
    let retire!: () => void;
    const started = new Promise<void>((resolve, reject) => {
      retire = () => {
        tracked.release();
        reject(signal?.reason);
      };
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", (error) => {
        tracked.release();
        reject(error);
      });
      signal?.addEventListener("abort", retire, { once: true });
      if (signal?.aborted) retire();
    });
    try {
      await started;
    } finally {
      signal?.removeEventListener("abort", retire);
    }
  }
}
