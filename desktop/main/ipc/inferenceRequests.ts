import { randomUUID } from "node:crypto";

import type { WebContents } from "electron";

import { waitForInference } from "../providers/sharedInference";

type Owner = {
  requests: Map<string, AbortController>;
  cleanup: () => void;
};

/** Request IDs are scoped to their trusted renderer, never a global cancel key. */
export class InferenceRequests {
  private readonly owners = new Map<WebContents, Owner>();
  private readonly lifetime = new AbortController();

  async run<T>(
    sender: WebContents,
    requestId: unknown,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    const id = requestId === undefined ? randomUUID() : this.id(requestId);
    if (sender.isDestroyed()) throw new Error("Inference renderer is closed");
    let owner = this.owners.get(sender);
    if (!owner) {
      const cancel = () => this.cancelOwner(sender);
      const navigate = (
        _event: unknown,
        _url: string,
        _inPlace: boolean,
        main: boolean
      ) => {
        if (main) cancel();
      };
      sender.on("destroyed", cancel);
      sender.on("render-process-gone", cancel);
      sender.on("did-start-navigation", navigate);
      owner = {
        requests: new Map(),
        cleanup: () => {
          sender.removeListener("destroyed", cancel);
          sender.removeListener("render-process-gone", cancel);
          sender.removeListener("did-start-navigation", navigate);
        }
      };
      this.owners.set(sender, owner);
    }
    if (owner.requests.has(id))
      throw new Error("Inference request ID is already active");
    const controller = new AbortController();
    owner.requests.set(id, controller);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    try {
      const result = await waitForInference(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return task(signal);
        }),
        signal
      );
      signal.throwIfAborted();
      return result;
    } finally {
      owner.requests.delete(id);
      if (!owner.requests.size && this.owners.get(sender) === owner) {
        owner.cleanup();
        this.owners.delete(sender);
      }
    }
  }

  cancel(sender: WebContents, requestId: unknown): void {
    this.owners.get(sender)?.requests.get(this.id(requestId))?.abort();
  }

  stop(): void {
    this.lifetime.abort();
    for (const sender of this.owners.keys()) this.cancelOwner(sender);
  }

  private cancelOwner(sender: WebContents): void {
    const owner = this.owners.get(sender);
    if (!owner) return;
    owner.cleanup();
    this.owners.delete(sender);
    for (const controller of owner.requests.values()) controller.abort();
  }

  private id(value: unknown): string {
    if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value))
      throw new Error("Invalid inference request ID");
    return value;
  }
}
