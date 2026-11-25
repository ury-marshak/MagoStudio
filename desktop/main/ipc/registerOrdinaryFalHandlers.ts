import { ipcMain, type WebContents } from "electron";

import { IPC_CHANNELS } from "../../shared/contracts";
import type { OrdinaryFalService } from "../ordinaryFal/ordinaryFalService";
import { waitForInference } from "../providers/sharedInference";

import { requireTrustedSender } from "./trustedSender";

export const ordinaryFalChannels = {
  submit: IPC_CHANNELS.ordinaryFalSubmit,
  get: IPC_CHANNELS.ordinaryFalGet,
  list: IPC_CHANNELS.ordinaryFalList
} as const;

export function registerOrdinaryFalHandlers(
  service: Pick<OrdinaryFalService, "submit" | "get" | "list">,
  captureAccountProfile: (sender: WebContents) => AbortSignal
): void {
  for (const action of ["submit", "get", "list"] as const) {
    ipcMain.handle(
      ordinaryFalChannels[action],
      async (event, input: unknown) => {
        requireTrustedSender(event);
        const origin = captureAccountProfile(event.sender);
        origin.throwIfAborted();
        // Forward typed submit rejections as data. A rejected invocation
        // is deliberately not equivalent to a main-side validation reply.
        const result = await waitForInference<unknown>(
          service[action](input, origin),
          origin
        );
        origin.throwIfAborted();
        return result;
      }
    );
  }
}
