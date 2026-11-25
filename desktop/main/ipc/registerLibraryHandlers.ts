import { copyFile } from "node:fs/promises";
import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent
} from "electron";

import {
  IPC_CHANNELS,
  type LibraryInfo,
  type SbsVideoExportInput
} from "../../shared/contracts";
import {
  CURRENT_SCHEMA_VERSION,
  DatabaseManager
} from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { exportSbsVideo } from "../exports/sbsVideoExport";
import { listLibraryIssues, reportLibraryIssue } from "../libraryHealth";
import { LibrarySettings } from "../librarySettings";
import { LibraryWorkSession } from "../libraryWorkSession";
import { logStartup } from "../startupDiagnostics";

import { registerRendererLibraryLifecycle } from "./rendererLibraryLifecycle";
import { requireTrustedSender } from "./trustedSender";

type ExportWork = Pick<
  LibraryWorkSession<unknown>,
  "run" | "capture" | "boundary"
>;

const toLibraryInfo = (rootPath: string): LibraryInfo => ({
  rootPath,
  databasePath: path.join(rootPath, "mago.sqlite3"),
  schemaVersion: CURRENT_SCHEMA_VERSION
});

export const registerLibraryHandlers = ({
  settings,
  databaseManager,
  repository,
  mediaWork: sharedMediaWork,
  beforeLibraryChange,
  afterLibraryChange
}: {
  settings: LibrarySettings;
  databaseManager: DatabaseManager;
  repository: ProjectRepository;
  /** If shared, the application suspends/drains and resets it in its callbacks. */
  mediaWork?: ExportWork;
  beforeLibraryChange?: () => Promise<void>;
  afterLibraryChange?: () => void;
}) => {
  const rendererLifecycle = registerRendererLibraryLifecycle();
  const ownMediaWork = new LibraryWorkSession(() => undefined);
  const mediaWork = sharedMediaWork ?? ownMediaWork;
  const suspend = async () => {
    await rendererLifecycle.suspend();
    await Promise.all([
      sharedMediaWork ? undefined : ownMediaWork.suspend(),
      beforeLibraryChange?.()
    ]);
  };
  // The dialog is not a drain boundary. Only admitted library I/O is.
  const handleExport = (
    channel: string,
    operation: (
      event: IpcMainInvokeEvent,
      value: unknown,
      signal: AbortSignal
    ) => Promise<boolean>
  ) => {
    ipcMain.handle(channel, async (event, value) => {
      requireTrustedSender(event);
      let signal: AbortSignal | undefined;
      try {
        return await mediaWork.run(() => {
          signal = mediaWork.capture();
          return operation(event, value, signal);
        });
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          return false;
        throw error;
      }
    });
  };
  ipcMain.handle(IPC_CHANNELS.libraryIssues, (event) => {
    requireTrustedSender(event);
    return listLibraryIssues();
  });
  ipcMain.handle(IPC_CHANNELS.libraryOpenLogs, (event) => {
    requireTrustedSender(event);
    shell.showItemInFolder(
      path.join(app.getPath("userData"), "logs", "startup.log")
    );
  });
  ipcMain.handle(IPC_CHANNELS.libraryRestoreBackup, async (event) => {
    requireTrustedSender(event);
    const root = await settings.getLibraryRoot();
    if (!root) throw new Error("Choose a library first.");
    const backups = await databaseManager.listBackups(root);
    if (!backups.length)
      throw new Error("No database backups are available yet.");
    const selected = dialog.showMessageBoxSync({
      type: "warning",
      title: "Restore Mago library",
      message: "Choose a database backup to restore.",
      detail:
        "Mago will restart after restoring. Changes after the backup will be lost. Images and videos are not included. The original database and journal files will be preserved.",
      buttons: [
        ...backups.map((file) =>
          new Date(Number(path.basename(file).split("-")[1])).toLocaleString()
        ),
        "Cancel"
      ],
      cancelId: backups.length,
      defaultId: backups.length
    });
    if (selected < 0 || selected >= backups.length) return;
    await suspend();
    await databaseManager.suspendForRecovery();
    try {
      const preserved = await databaseManager.restoreBackup(
        root,
        backups[selected]
      );
      logStartup(
        `Restored library backup; original files preserved at ${preserved}`
      );
      app.relaunch();
      app.exit(0);
    } catch (error) {
      reportLibraryIssue({
        id: "restore",
        kind: "service",
        message: `Restore failed: ${String(error)}. Restart Mago to reopen your library.`
      });
      throw error;
    }
  });
  ipcMain.handle(IPC_CHANNELS.appVersion, (event) => {
    requireTrustedSender(event);
    return app.getVersion();
  });

  handleExport(IPC_CHANNELS.filesSaveAssetAs, async (event, value, signal) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("The Mago window is unavailable");
    const input = value as { assetId?: unknown; suggestedName?: unknown };
    if (typeof input.assetId !== "string" || !input.assetId) {
      throw new Error("assetId must be a non-empty string");
    }
    const assetId = input.assetId;
    const sourcePath = await mediaWork.boundary(() =>
      repository.assetSourcePath(assetId)
    );
    signal.throwIfAborted();
    if (!sourcePath)
      throw new Error("This render is not available on disk yet");
    const suggestedName =
      typeof input.suggestedName === "string" && input.suggestedName
        ? input.suggestedName
        : path.basename(sourcePath);
    const result = await dialog.showSaveDialog(window, {
      title: "Save render",
      defaultPath: `${path.parse(suggestedName).name}${path.extname(sourcePath)}`
    });
    signal.throwIfAborted();
    const destination = result.filePath;
    if (result.canceled || !destination || event.sender.isDestroyed())
      return false;
    await mediaWork.boundary(() => copyFile(sourcePath, destination));
    return true;
  });

  handleExport(
    IPC_CHANNELS.filesExportSbsVideo,
    async (event, value, signal) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) throw new Error("The Mago window is unavailable");
      const candidate = value as Partial<SbsVideoExportInput>;
      const string = (key: keyof SbsVideoExportInput): string => {
        const item = candidate[key];
        if (typeof item !== "string" || !item.trim())
          throw new Error(`${key} must be a non-empty string`);
        return item;
      };
      const integer = (key: "startFrame" | "endFrame"): number => {
        const item = candidate[key];
        if (typeof item !== "number" || !Number.isInteger(item) || item < 0)
          throw new Error(`${key} must be a non-negative integer`);
        return item;
      };
      const requestId = string("requestId");
      const inputAssetId = string("inputAssetId");
      const renderAssetId = string("renderAssetId");
      const startFrame = integer("startFrame");
      const endFrame = integer("endFrame");
      const fps = candidate.fps;
      if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0)
        throw new Error("fps must be a positive finite number");
      if (endFrame < startFrame)
        throw new Error("endFrame must be at least startFrame");

      const [inputPath, renderPath, inputAsset] = await Promise.all([
        mediaWork.boundary(() => repository.assetSourcePath(inputAssetId)),
        mediaWork.boundary(() => repository.assetSourcePath(renderAssetId)),
        mediaWork.boundary(() => repository.getAsset(inputAssetId))
      ]);
      signal.throwIfAborted();
      if (!inputPath || !renderPath)
        throw new Error("The comparison videos are not available on disk");

      const suggestedName = path.basename(string("suggestedName"));
      const result = await dialog.showSaveDialog(window, {
        title: "Save side-by-side comparison",
        defaultPath: suggestedName.toLowerCase().endsWith(".mp4")
          ? suggestedName
          : `${suggestedName}.mp4`,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }]
      });
      signal.throwIfAborted();
      const destination = result.filePath;
      if (result.canceled || !destination || event.sender.isDestroyed())
        return false;

      await mediaWork.boundary(() =>
        exportSbsVideo(
          {
            inputPath,
            renderPath,
            destinationPath: destination,
            startFrame,
            endFrame,
            fps,
            signal,
            horizontal: (inputAsset?.width ?? 1) >= (inputAsset?.height ?? 1)
          },
          (percentage) => {
            if (!signal.aborted && !event.sender.isDestroyed()) {
              event.sender.send(IPC_CHANNELS.filesSbsExportProgress, {
                requestId,
                percentage
              });
            }
          }
        )
      );
      return true;
    }
  );

  ipcMain.handle(IPC_CHANNELS.libraryGet, async (event) => {
    requireTrustedSender(event);
    const rootPath = await settings.getLibraryRoot();
    return rootPath ? toLibraryInfo(rootPath) : null;
  });

  ipcMain.handle(IPC_CHANNELS.libraryChoose, async (event) => {
    requireTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("The Mago window is unavailable");
    const result = await dialog.showOpenDialog(window, {
      title: "Choose Mago library folder",
      buttonLabel: "Use this folder",
      properties: ["openDirectory", "createDirectory"]
    });
    const rootPath = result.filePaths[0];
    if (result.canceled || !rootPath) return null;

    await settings.assertWritable(rootPath);
    await suspend();
    await databaseManager.open(rootPath);
    await settings.setLibraryRoot(rootPath);
    afterLibraryChange?.();
    if (!sharedMediaWork) ownMediaWork.reset();
    rendererLifecycle.reset();
    return toLibraryInfo(rootPath);
  });

  ipcMain.handle(IPC_CHANNELS.libraryReveal, async (event) => {
    requireTrustedSender(event);
    const rootPath = await settings.getLibraryRoot();
    if (!rootPath) throw new Error("No Mago library folder is selected");
    const errorMessage = await shell.openPath(rootPath);
    if (errorMessage) throw new Error(errorMessage);
  });
  return rendererLifecycle;
};
