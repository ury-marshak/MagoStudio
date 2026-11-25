import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

/** Dispose synchronously at retirement, even if a decoder read never settles. */
export async function withRendererMediaInput<T>(
  input: { dispose(): void },
  work: RendererLibraryWork,
  read: () => Promise<T>
): Promise<T> {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.dispose();
  };
  let onAbort!: () => void;
  try {
    work.check();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(work.signal.reason);
        dispose();
      };
      work.signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([read(), aborted]);
    work.check();
    return result;
  } finally {
    work.signal.removeEventListener("abort", onAbort);
    dispose();
    work.check();
  }
}
