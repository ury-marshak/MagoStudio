import { randomUUID } from "node:crypto";

import { ipcMain, type WebContents } from "electron";

import { requireTrustedSender } from "./trustedSender";

const RENDERER_DRAIN_TIMEOUT_MS = 30000;

/** Only preloads with registered library-owned work participate. A renderer
 * acknowledgement means its issued media/cache operations have drained, not
 * that a provider job was cancelled. Failure refuses database replacement. */
export function registerRendererLibraryLifecycle() {
  const renderers = new Map<WebContents, string>();
  let changing = false;
  const pending = new Map<
    WebContents,
    {
      id: string;
      document: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();
  ipcMain.handle("library:watch", (event, document: unknown) => {
    requireTrustedSender(event);
    if (typeof document !== "string" || !document)
      throw new Error("Library watcher requires a document ID");
    const request = pending.get(event.sender);
    if (request && request.document !== document) {
      // A fresh preload on the same WebContents cannot vouch for the prior
      // document’s drains. Refuse replacement rather than pretending it can.
      request.reject(
        new Error("Renderer document changed before library teardown finished")
      );
    }
    renderers.set(event.sender, document);
    if (changing) event.sender.send("library:will-change", null, document);
  });
  ipcMain.handle(
    "library:drained",
    (event, id: unknown, error: unknown, document: unknown) => {
      requireTrustedSender(event);
      const request = pending.get(event.sender);
      if (!request || request.id !== id || request.document !== document)
        return;
      if (error) request.reject(new Error("Renderer library teardown failed"));
      else request.resolve();
    }
  );
  return {
    assertAvailable(): void {
      if (changing) throw new DOMException("Library changed", "AbortError");
    },
    async suspend(): Promise<void> {
      if (changing) throw new Error("A library change is already in progress");
      changing = true;
      await Promise.all(
        [...renderers].map(async ([renderer, document]) => {
          if (renderer.isDestroyed()) {
            renderers.delete(renderer);
            return;
          }
          const id = randomUUID();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const destroyed = () => pending.get(renderer)?.resolve();
          try {
            await new Promise<void>((resolve, reject) => {
              pending.set(renderer, { id, document, resolve, reject });
              renderer.once("destroyed", destroyed);
              timer = setTimeout(
                () => reject(new Error("Renderer library teardown timed out")),
                RENDERER_DRAIN_TIMEOUT_MS
              );
              renderer.send("library:will-change", id, document);
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
      for (const [renderer, document] of renderers) {
        if (!renderer.isDestroyed())
          renderer.send("library:did-change", document);
        else renderers.delete(renderer);
      }
    }
  };
}
