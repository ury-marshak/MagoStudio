import { randomUUID } from "node:crypto";

import { ipcMain, type WebContents } from "electron";

import { requireTrustedSender } from "./trustedSender";

const RENDERER_DRAIN_TIMEOUT_MS = 30000;

/** Only preloads with registered library-owned work participate. A renderer
 * acknowledgement means its issued media/cache operations have drained, not
 * that a provider job was cancelled. Failure refuses database replacement. */
export function registerRendererLibraryLifecycle() {
  const renderers = new Set<WebContents>();
  let changing = false;
  const pending = new Map<
    WebContents,
    {
      id: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();
  ipcMain.handle("library:watch", (event) => {
    requireTrustedSender(event);
    renderers.add(event.sender);
    if (changing) event.sender.send("library:will-change", null);
  });
  ipcMain.handle("library:drained", (event, id: unknown, error: unknown) => {
    requireTrustedSender(event);
    const request = pending.get(event.sender);
    if (!request || request.id !== id) return;
    if (error) request.reject(new Error("Renderer library teardown failed"));
    else request.resolve();
  });
  return {
    async suspend(): Promise<void> {
      if (changing) throw new Error("A library change is already in progress");
      changing = true;
      await Promise.all(
        [...renderers].map(async (renderer) => {
          if (renderer.isDestroyed()) {
            renderers.delete(renderer);
            return;
          }
          const id = randomUUID();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const destroyed = () => pending.get(renderer)?.resolve();
          try {
            await new Promise<void>((resolve, reject) => {
              pending.set(renderer, { id, resolve, reject });
              renderer.once("destroyed", destroyed);
              timer = setTimeout(
                () => reject(new Error("Renderer library teardown timed out")),
                RENDERER_DRAIN_TIMEOUT_MS
              );
              renderer.send("library:will-change", id);
            });
          } finally {
            clearTimeout(timer);
            renderer.removeListener("destroyed", destroyed);
            pending.delete(renderer);
          }
        })
      );
    },
    reset(): void {
      changing = false;
      for (const renderer of renderers) {
        if (!renderer.isDestroyed()) renderer.send("library:did-change");
        else renderers.delete(renderer);
      }
    }
  };
}
