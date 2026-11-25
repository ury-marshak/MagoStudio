import {
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
  type WebFrameMain
} from "electron";

import { IPC_CHANNELS } from "../../shared/contracts";
import type { LibrarySettings } from "../librarySettings";
import type { ProfileLifetime } from "../providers/profileLifetime";

import { requireTrustedSender } from "./trustedSender";

const RETIRE_ACK_TIMEOUT_MS = 5000;

export const createAccountLifecycle = (
  profiles: ProfileLifetime,
  { drainRetired }: { drainRetired?: () => Promise<void> } = {}
) => {
  const windows = new WeakMap<WebContents, AbortSignal>();
  let previousWrite = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = previousWrite.then(operation);
    previousWrite = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  return {
    serialize,
    bindWindow(sender: WebContents): void {
      if (windows.has(sender)) throw new Error("Account window already bound");
      profiles.resume();
      const signal = profiles.capture();
      windows.set(sender, signal);
      const retire = () => {
        try {
          if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.accountRetired);
        } catch {
          // The window can be destroyed while the notification is being sent.
        }
      };
      signal.addEventListener("abort", retire, { once: true });
      sender.on("destroyed", () => signal.removeEventListener("abort", retire));
    },
    capture(sender: WebContents): AbortSignal {
      const signal = windows.get(sender);
      if (!signal || sender.isDestroyed())
        throw new Error("Unknown account window");
      signal.throwIfAborted();
      return signal;
    },
    retire(): void {
      profiles.suspend();
    },
    async drainRetired(): Promise<void> {
      await drainRetired?.();
    },
    // Called inside serialize. A failed write or replacement never re-admits
    // the retired window. Only binding a fresh window admits new work.
    async replace<T>(
      write: () => Promise<void>,
      rebuild: () => Promise<T>
    ): Promise<T> {
      profiles.suspend();
      await drainRetired?.();
      await write();
      try {
        return await rebuild();
      } catch (error) {
        profiles.suspend();
        throw error;
      }
    }
  };
};

const requireAccountSender = (event: IpcMainInvokeEvent): void => {
  requireTrustedSender(event);
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Account changes require the main window frame");
  }
};

/** The app mode is baked into additionalArguments, so changing it replaces the window. */
export const registerAccountHandlers = (options: {
  settings: Pick<LibrarySettings, "setAppMode" | "clearAppMode">;
  lifecycle: ReturnType<typeof createAccountLifecycle>;
  rebuildWindow: () => Promise<void>;
}): void => {
  const { lifecycle, settings, rebuildWindow } = options;
  const signingOut = new WeakMap<WebContents, WebFrameMain>();
  const retireAcks = new WeakMap<WebContents, () => void>();

  // A renderer may already be in a synchronous publication turn when its
  // profile is retired in main. Wait for the preload to cross that turn
  // before persisting a new mode or asking Clerk to sign out.
  const retireRenderer = async (sender: WebContents): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveAck: () => void = () => undefined;
    const ack = new Promise<void>((resolve, reject) => {
      resolveAck = resolve;
      timer = setTimeout(
        () => reject(new Error("Account window retirement timed out")),
        RETIRE_ACK_TIMEOUT_MS
      );
    });
    try {
      retireAcks.set(sender, resolveAck);
      sender.once("destroyed", resolveAck);
      lifecycle.retire();
      await ack;
    } finally {
      clearTimeout(timer);
      sender.removeListener("destroyed", resolveAck);
      retireAcks.delete(sender);
    }
  };

  ipcMain.on(IPC_CHANNELS.accountRetiredAck, (event) => {
    try {
      requireAccountSender(event);
      retireAcks.get(event.sender)?.();
    } catch {
      // An unrelated frame cannot acknowledge retirement for the window.
    }
  });

  ipcMain.on(IPC_CHANNELS.accountIsCurrent, (event) => {
    event.returnValue = false;
    try {
      requireAccountSender(event);
      lifecycle.capture(event.sender);
      event.returnValue = true;
    } catch {
      // Trust and window admission are both required.
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.accountChooseMode,
    async (event, mode: unknown) => {
      requireAccountSender(event);
      if (mode !== "cloud" && mode !== "offline") {
        throw new Error("Unknown Mago app mode");
      }
      const origin = lifecycle.capture(event.sender);
      await lifecycle.serialize(async () => {
        origin.throwIfAborted();
        requireAccountSender(event);
        lifecycle.capture(event.sender);
        await retireRenderer(event.sender);
        await lifecycle.replace(() => settings.setAppMode(mode), rebuildWindow);
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.accountBeginSignOut, async (event) => {
    requireAccountSender(event);
    const origin = lifecycle.capture(event.sender);
    await lifecycle.serialize(async () => {
      origin.throwIfAborted();
      requireAccountSender(event);
      lifecycle.capture(event.sender);
      const frame = event.senderFrame!;
      await retireRenderer(event.sender);
      await lifecycle.drainRetired();
      signingOut.set(event.sender, frame);
    });
  });

  ipcMain.handle(IPC_CHANNELS.accountSignOut, async (event) => {
    requireAccountSender(event);
    const sender = event.sender;
    await lifecycle.serialize(async () => {
      requireAccountSender(event);
      if (
        sender.isDestroyed() ||
        signingOut.get(sender) !== event.senderFrame
      ) {
        throw new Error("The account window did not begin sign-out");
      }
      signingOut.delete(sender);
      await lifecycle.replace(() => settings.clearAppMode(), rebuildWindow);
    });
  });
};
