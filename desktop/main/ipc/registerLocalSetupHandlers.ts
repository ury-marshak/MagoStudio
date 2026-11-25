import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type WebContents
} from "electron";

import { IPC_CHANNELS } from "../../shared/contracts";
import { LibrarySettings } from "../librarySettings";
import { chooseInstallFolder } from "../localSetup/chooseInstallFolder";
import {
  MANUAL_COMFY_MODEL_COPY_MESSAGE,
  modelCopyConfirmationMessage
} from "../localSetup/confirmAndCopyInstallerModels";
import { downloadSetupRequirement } from "../localSetup/downloadSetupRequirement";
import { downloadSetupRequirements } from "../localSetup/downloadSetupRequirements";
import {
  listStorageDrives,
  readStorageSpace
} from "../localSetup/listStorageDrives";
import { probeHardware } from "../localSetup/probeHardware";
import { readLocalModelGroupsStatus } from "../localSetup/readLocalModelGroupsStatus";
import { readStarterInstallRequest } from "../localSetup/readStarterInstallRequest";
import { readVideoMemoryBytesOnce } from "../localSetup/readVideoMemoryBytesOnce";
import { SETUP_PAUSED, SetupAttempt } from "../localSetup/setupAttempt";
import { StarterInstaller } from "../localSetup/starterInstaller";

import { requireTrustedSender } from "./trustedSender";

export const registerLocalSetupHandlers = (options: {
  settings: LibrarySettings;
  assertInferenceAvailable?: () => Promise<void>;
  captureProfile?: (sender: WebContents) => AbortSignal;
}): { drainRetired: () => Promise<void> } => {
  const installer = new StarterInstaller(options.settings, {
    confirmModelCopy: async (bytes) => {
      const result = await dialog.showMessageBox({
        type: "question",
        title: "Copy models to your ComfyUI?",
        message: modelCopyConfirmationMessage(bytes),
        buttons: ["Copy model files", "Keep in installation folder"],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      return result.response === 0;
    },
    showModelCopyError: async () => {
      await dialog.showMessageBox({
        type: "error",
        title: "Copy model files manually",
        message: MANUAL_COMFY_MODEL_COPY_MESSAGE,
        buttons: ["OK"]
      });
    }
  });
  const active = new Set<SetupAttempt>();
  const capture = (sender: WebContents) => {
    const signal = options.captureProfile?.(sender);
    signal?.throwIfAborted();
    return signal;
  };
  const run = async <T>(attempt: SetupAttempt, operation: () => Promise<T>) => {
    active.add(attempt);
    let result: T;
    try {
      result = await attempt.run(operation);
    } finally {
      await attempt.drain();
      active.delete(attempt);
    }
    attempt.signal.throwIfAborted();
    return result;
  };
  const assertAllowed = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    await options.assertInferenceAvailable?.();
    signal.throwIfAborted();
  };
  let installerAdmission: SetupAttempt | undefined;
  ipcMain.handle(IPC_CHANNELS.localSetupInstallerStatus, async (event) => {
    requireTrustedSender(event);
    const hasCompletedInstall = await options.settings.hasCompletedLocalSetup({
      allowNetwork: false
    });
    return { ...installer.status(), hasCompletedInstall };
  });
  ipcMain.handle(
    IPC_CHANNELS.localSetupInstallerStart,
    async (event, request: unknown) => {
      requireTrustedSender(event);
      const profile = capture(event.sender);
      if (installerAdmission && !installerAdmission.signal.aborted)
        return installer.status();
      const attempt = new SetupAttempt(profile);
      installerAdmission = attempt;
      try {
        return await run(attempt, async () => {
          await assertAllowed(attempt.signal);
          return installer.start(readStarterInstallRequest(request), profile);
        });
      } finally {
        if (installerAdmission === attempt) installerAdmission = undefined;
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.localSetupModelGroupsStatus, async (event) => {
    requireTrustedSender(event);
    const attempt = new SetupAttempt(capture(event.sender));
    return run(attempt, async () => {
      await assertAllowed(attempt.signal);
      return readLocalModelGroupsStatus(
        options.settings,
        readVideoMemoryBytesOnce,
        attempt
      );
    });
  });
  ipcMain.handle(IPC_CHANNELS.localSetupInstallerPause, async (event) => {
    requireTrustedSender(event);
    installerAdmission?.pause();
    await installer.pause();
  });
  ipcMain.handle(
    IPC_CHANNELS.localSetupAcceptedModelLicenseRepos,
    async (event) => {
      requireTrustedSender(event);
      return options.settings.getAcceptedModelLicenseRepos();
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.localSetupAcceptModelLicenses,
    async (event, huggingFaceRepos) => {
      requireTrustedSender(event);
      if (
        !Array.isArray(huggingFaceRepos) ||
        huggingFaceRepos.some((repo) => typeof repo !== "string")
      )
        throw new Error("Accept licenses by Hugging Face repo name.");
      await options.settings.acceptModelLicenses(huggingFaceRepos);
    }
  );
  ipcMain.handle(IPC_CHANNELS.localSetupListDrives, async (event) => {
    requireTrustedSender(event);
    const savedFolder = await options.settings.getLocalModelsRoot();
    const rootPath = savedFolder ?? app.getPath("documents");
    const preferred = {
      id: rootPath,
      name: savedFolder ? "Previously selected folder" : "Documents (default)",
      rootPath,
      freeGigabytes: await readStorageSpace(rootPath)
    };
    const drives = await listStorageDrives().catch(() => []);
    return [preferred, ...drives.filter((drive) => drive.id !== preferred.id)];
  });
  ipcMain.handle(
    IPC_CHANNELS.localSetupSelectStorageFolder,
    async (event, folderPath) => {
      requireTrustedSender(event);
      const attempt = new SetupAttempt(capture(event.sender));
      if (typeof folderPath !== "string" || !path.isAbsolute(folderPath))
        throw new Error("Choose an absolute storage folder.");
      return run(attempt, async () => {
        const freeGigabytes = await readStorageSpace(folderPath);
        if (freeGigabytes === null)
          throw new Error(
            "Unable to read free space. Reconnect the drive or choose another folder."
          );
        await attempt.issue(() =>
          options.settings.setLocalModelsRoot(folderPath, attempt.signal)
        );
        return { folderPath, freeGigabytes };
      });
    }
  );
  const downloads = new Map<string, SetupAttempt>();
  const approvals = new Map<
    string,
    {
      folder: string;
      token: string;
      profile: AbortSignal | undefined;
      forget: () => void;
    }
  >();
  const readDownloadSettings = async (signal: AbortSignal) => {
    const [endpoint, vlmBackend, scriptTextModel, textModelProvider] =
      await Promise.all([
        options.settings.getComfyEndpoint(),
        options.settings.getVlmBackend(),
        options.settings.getScriptTextModel(),
        options.settings.getTextModelProvider()
      ]);
    signal.throwIfAborted();
    return { endpoint, vlmBackend, scriptTextModel, textModelProvider };
  };
  const runDownload = async <T>(
    key: string,
    profile: AbortSignal | undefined,
    operation: (attempt: SetupAttempt) => Promise<T>
  ) => {
    const previous = downloads.get(key);
    if (previous && !previous.signal.aborted)
      throw new Error("This download is already running.");
    const attempt = new SetupAttempt(profile);
    downloads.set(key, attempt);
    const priorCleanup = previous && attempt.track(previous.drain());
    try {
      const result = await run(attempt, async () => {
        await priorCleanup;
        await assertAllowed(attempt.signal);
        return operation(attempt);
      });
      attempt.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (attempt.signal.aborted) throw new Error(SETUP_PAUSED);
      throw error;
    } finally {
      if (downloads.get(key) === attempt) downloads.delete(key);
    }
  };
  ipcMain.handle(IPC_CHANNELS.localSetupPauseDownload, async (event, name) => {
    requireTrustedSender(event);
    const key = `${event.sender?.id}:${name}`;
    approvals.get(key)?.forget();
    const attempt = downloads.get(key);
    attempt?.pause();
    await attempt?.drain();
  });
  ipcMain.handle(
    IPC_CHANNELS.localSetupDownloadRequirement,
    async (event, name, downloadOptions: unknown) => {
      requireTrustedSender(event);
      const profile = capture(event.sender);
      if (typeof name !== "string") throw new Error("Invalid requirement");
      const replaceExistingNodePackIn =
        typeof downloadOptions === "object" &&
        downloadOptions !== null &&
        "replaceExistingNodePackIn" in downloadOptions &&
        typeof downloadOptions.replaceExistingNodePackIn === "string"
          ? downloadOptions.replaceExistingNodePackIn
          : undefined;
      const approvalToken =
        typeof downloadOptions === "object" &&
        downloadOptions !== null &&
        "approvalToken" in downloadOptions &&
        typeof downloadOptions.approvalToken === "string"
          ? downloadOptions.approvalToken
          : undefined;
      const key = `${event.sender?.id}:${name}`;
      // Capture the offered approval before policy awaits. Never consume one
      // issued by a different attempt while this call was suspended.
      const approval = approvals.get(key);
      return runDownload(key, profile, async (attempt) => {
        if (
          replaceExistingNodePackIn !== undefined &&
          (approval?.folder !== replaceExistingNodePackIn ||
            approval.profile !== profile ||
            approvals.get(key) !== approval ||
            (profile !== undefined && approval.token !== approvalToken))
        )
          throw new Error(
            "Confirm the node pack update from the download that asked for it."
          );
        approval?.forget();
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new Error("No window available");
        const result = await downloadSetupRequirement(
          window,
          await readDownloadSettings(attempt.signal),
          name,
          attempt.signal,
          { replaceExistingNodePackIn, attempt }
        );
        attempt.signal.throwIfAborted();
        if (result?.outcome === "node-pack-update-needs-confirmation") {
          const offered = {
            folder: result.customNodesFolder,
            token: randomUUID(),
            profile,
            forget: () => {
              if (approvals.get(key) === offered) approvals.delete(key);
              profile?.removeEventListener("abort", offered.forget);
            }
          };
          approvals.set(key, offered);
          profile?.addEventListener("abort", offered.forget, { once: true });
          return { ...result, approvalToken: offered.token };
        }
        return result;
      });
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.localSetupDownloadRequirements,
    async (event, batchName, names) => {
      requireTrustedSender(event);
      const profile = capture(event.sender);
      if (
        typeof batchName !== "string" ||
        !Array.isArray(names) ||
        names.some((name) => typeof name !== "string")
      )
        throw new Error("Invalid requirements");
      const key = `${event.sender?.id}:${batchName}`;
      return runDownload(key, profile, async (attempt) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new Error("No window available");
        return downloadSetupRequirements(
          window,
          await readDownloadSettings(attempt.signal),
          names,
          attempt.signal,
          attempt
        );
      });
    }
  );
  ipcMain.handle(IPC_CHANNELS.localSetupProbeHardware, async (event) => {
    requireTrustedSender(event);
    const attempt = new SetupAttempt(capture(event.sender));
    return run(attempt, async () => {
      await assertAllowed(attempt.signal);
      return probeHardware();
    });
  });

  ipcMain.handle(IPC_CHANNELS.localSetupChooseFolder, async (event) => {
    requireTrustedSender(event);
    const attempt = new SetupAttempt(capture(event.sender));
    return run(attempt, async () => {
      const defaultPath =
        (await options.settings.getLocalModelsRoot()) ??
        app.getPath("documents");
      attempt.signal.throwIfAborted();
      const choice = await chooseInstallFolder(
        BrowserWindow.fromWebContents(event.sender),
        defaultPath
      );
      attempt.signal.throwIfAborted();
      if (choice)
        await attempt.issue(() =>
          options.settings.setLocalModelsRoot(choice.folderPath, attempt.signal)
        );
      return choice;
    });
  });

  return {
    drainRetired: async () => {
      await Promise.all([
        installer.drainRetired(),
        ...[...active]
          .filter(({ signal }) => signal.aborted)
          .map((attempt) => attempt.drain())
      ]);
    }
  };
};
