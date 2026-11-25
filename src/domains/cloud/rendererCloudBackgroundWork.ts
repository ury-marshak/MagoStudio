import { captureRendererCloudAccountScope } from "@/platform/rendererCloudAccountScope";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

// Account retirement stops continuations, not the library's drain of local IPC
// already dispatched. Main-owned transfers do not use this local IPC boundary.
export const rendererCloudBackgroundWork = (
  origin: RendererLibraryWork,
  ...signals: AbortSignal[]
): RendererLibraryWork => {
  const account = captureRendererCloudAccountScope();
  const signal = AbortSignal.any([
    origin.signal,
    ...(account.signal ? [account.signal] : []),
    ...signals
  ]);
  const check = () => {
    origin.check();
    signal.throwIfAborted();
    if (!account.isActive()) {
      throw new DOMException("Cloud account is not active", "AbortError");
    }
  };
  return {
    ...origin,
    signal,
    check,
    ready: async () => {
      await origin.ready();
      check();
    },
    boundary: (run) =>
      origin.boundary(async () => {
        check();
        try {
          return await run();
        } finally {
          check();
        }
      })
  };
};
