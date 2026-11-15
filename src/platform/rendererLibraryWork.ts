import { getLocalDesktopApi, isLocalApp } from "./localDesktop";

const HEX_RADIX = 16;

export class RendererLibrarySession {
  private controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private stops = new Set<() => Promise<void>>();
  private suspended = false;
  private connected = false;
  private namespace?: Promise<string>;
  private readiness: Promise<void> = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();

  getSnapshot = (): number => this.version;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  capture(): RendererLibraryWork {
    this.connect();
    const signal = this.controller.signal;
    // Capturing is safe during render/suspension; dispatch still requires
    // check/ready/boundary. Old query closures retain this exact signal.
    return {
      signal,
      check: () => signal.throwIfAborted(),
      ready: async () => {
        await this.readiness;
        signal.throwIfAborted();
      },
      boundary: async <T>(run: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        // Register before invoking user code, including synchronous failures.
        const task = this.readiness.then(() => {
          signal.throwIfAborted();
          return run();
        });
        this.pending.add(task);
        try {
          const result = await task;
          signal.throwIfAborted();
          return result;
        } finally {
          this.pending.delete(task);
        }
      },
      cacheKey: async (key: string) => {
        await this.readiness;
        signal.throwIfAborted();
        if (!isLocalApp) return key;
        // Old unscoped OPFS entries have no provable library identity. Keep
        // them on disk, but never use them for a possibly reused desktop ID.
        this.namespace ??= getLocalDesktopApi()
          .library.get()
          .then(async (info) => {
            if (!info) throw new Error("Choose a Mago library first");
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(info.rootPath)
            );
            return Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(HEX_RADIX).padStart(2, "0")
            ).join("");
          });
        const namespace = await this.namespace;
        signal.throwIfAborted();
        return `${namespace}_${key}`;
      }
    };
  }

  onSuspend(stop: () => Promise<void>): () => void {
    this.stops.add(stop);
    return () => this.stops.delete(stop);
  }

  async suspend(): Promise<void> {
    const changed = !this.suspended;
    this.suspended = true;
    this.controller.abort(new DOMException("Library changed", "AbortError"));
    const stopped = [...this.stops].map((stop) => stop());
    if (changed) this.publish();
    // Abort listeners may synchronously register body cleanup work.
    await Promise.all(stopped);
    while (this.pending.size) await Promise.allSettled(this.pending);
  }

  reset(): void {
    if (!this.suspended) return;
    this.controller = new AbortController();
    this.namespace = undefined;
    this.suspended = false;
    this.publish();
  }

  private connect(): void {
    if (this.connected || !isLocalApp) return;
    const library = getLocalDesktopApi().library;
    this.readiness = library.onWillChange(() => this.suspend());
    // A metadata-only/local URL caller may not await readiness. Dispatching
    // callers still observe the original rejected promise and fail closed.
    void this.readiness.catch(() => {});
    library.onDidChange(() => this.reset());
    this.connected = true;
  }
}

export interface RendererLibraryWork {
  signal: AbortSignal;
  check(): void;
  ready(): Promise<void>;
  boundary<T>(run: () => Promise<T>): Promise<T>;
  cacheKey(key: string): Promise<string>;
}

export const rendererLibrary = new RendererLibrarySession();
