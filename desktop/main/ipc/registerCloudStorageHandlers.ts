import path from "node:path";

import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron";

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS } from "../../shared/contracts";
import { requireCloudAccount } from "../cloud/requireCloudAccount";
import { parseAllowedCloudStorageUrl } from "../cloudStorage/parseAllowedCloudStorageUrl";
import { saveCloudStorageObject } from "../cloudStorage/saveCloudStorageObject";
import type { LibrarySettings } from "../librarySettings";
import type { LibraryWorkSession } from "../libraryWorkSession";
import type { ProfileIoDrain } from "../providers/profileIoDrain";

import { requireTrustedSender } from "./trustedSender";

export const registerCloudStorageHandlers = (
  settings: LibrarySettings,
  {
    libraryWork,
    assertLibraryAvailable,
    captureAccountProfile,
    profileIoDrain
  }: {
    libraryWork: Pick<LibraryWorkSession<undefined>, "capture" | "boundary">;
    assertLibraryAvailable: () => void;
    captureAccountProfile?: (sender: WebContents) => AbortSignal;
    profileIoDrain?: Pick<ProfileIoDrain, "run">;
  }
): void => {
  const allowedHosts = resolveCloudConfig().cloudStorageHosts;

  ipcMain.handle(
    IPC_CHANNELS.filesSaveCloudStorageObjectAs,
    async (event, value) => {
      requireTrustedSender(event);
      let library: AbortSignal | undefined;
      let committed = false;
      try {
        assertLibraryAvailable();
        library = libraryWork.capture();
        const profile = captureAccountProfile?.(event.sender);
        const signal = profile ? AbortSignal.any([library, profile]) : library;
        await requireCloudAccount(settings, signal);
        signal.throwIfAborted();
        assertLibraryAvailable();
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new Error("The Mago window is unavailable");
        const input = (value ?? {}) as {
          url?: unknown;
          suggestedName?: unknown;
        };
        const objectUrl = parseAllowedCloudStorageUrl(input.url, allowedHosts);
        const suggestedName =
          typeof input.suggestedName === "string" && input.suggestedName.trim()
            ? path.basename(input.suggestedName)
            : path.posix.basename(objectUrl.pathname);
        // The native dialog can remain open across a library switch. Only
        // an approved transfer (including body/file cleanup) is drained.
        const result = await dialog.showSaveDialog(window, {
          title: "Save download",
          defaultPath: suggestedName
        });
        signal.throwIfAborted();
        const destinationPath = result.filePath;
        if (result.canceled || !destinationPath || event.sender.isDestroyed())
          return false;
        assertLibraryAvailable();
        const transfer = () =>
          libraryWork.boundary(async () => {
            await saveCloudStorageObject({
              assertAccess: () => requireCloudAccount(settings, signal),
              signal,
              url: objectUrl.toString(),
              allowedHosts,
              destinationPath
            });
            committed = true;
          });
        await (profileIoDrain?.run(profile, transfer) ?? transfer());
        return true;
      } catch (error) {
        if (library?.aborted) return committed;
        throw error;
      }
    }
  );
};
