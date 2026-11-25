import type { RendererLibraryWork } from "./rendererLibraryWork";

const releases = new Map<string, () => void>();

/** Keep URLs shared by caches usable until library retirement. A consumer
 * that owns a temporary URL can release it sooner (safe even after abort). */
export function createRendererObjectUrl(
  blob: Blob,
  work: RendererLibraryWork
): string {
  work.check();
  const url = URL.createObjectURL(blob);
  const release = () => {
    releases.delete(url);
    work.signal.removeEventListener("abort", release);
    URL.revokeObjectURL(url);
  };
  releases.set(url, release);
  work.signal.addEventListener("abort", release, { once: true });
  return url;
}

/** Only revoke URLs minted here, never a caller-supplied fallback URL. */
export function releaseRendererObjectUrl(url: string): void {
  releases.get(url)?.();
}
