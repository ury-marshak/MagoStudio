import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopApi = vi.hoisted(() => ({ createProject: vi.fn() }));

vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: false,
  getLocalDesktopApi: () => ({
    projects: { create: desktopApi.createProject }
  })
}));

const createdFolderDummyProject = {
  id: "folder-project",
  name: "local",
  description: "Folder dummy project",
  active: true,
  settings: { rangeMin: 0, rangeMax: 48, folders: [] }
};

const loadCreateLocalFolderDummyProjectOnce = async () => {
  vi.resetModules();
  const freshlyImportedModule =
    await import("./createLocalFolderDummyProjectOnce");
  return freshlyImportedModule.createLocalFolderDummyProjectOnce;
};

describe("createLocalFolderDummyProjectOnce", () => {
  beforeEach(() => {
    desktopApi.createProject.mockReset();
  });

  it("creates one folder project for concurrent first folder writes", async () => {
    desktopApi.createProject.mockResolvedValue(createdFolderDummyProject);
    const createLocalFolderDummyProjectOnce =
      await loadCreateLocalFolderDummyProjectOnce();

    const [first, second] = await Promise.all([
      createLocalFolderDummyProjectOnce("local"),
      createLocalFolderDummyProjectOnce("local")
    ]);

    expect(desktopApi.createProject).toHaveBeenCalledTimes(1);
    expect(first.id).toBe("folder-project");
    expect(second.id).toBe("folder-project");
  });

  it("tries again after a failed creation", async () => {
    desktopApi.createProject
      .mockRejectedValueOnce(new Error("library busy"))
      .mockResolvedValueOnce(createdFolderDummyProject);
    const createLocalFolderDummyProjectOnce =
      await loadCreateLocalFolderDummyProjectOnce();

    await expect(createLocalFolderDummyProjectOnce("local")).rejects.toThrow(
      "library busy"
    );
    await expect(createLocalFolderDummyProjectOnce("local")).resolves.toEqual(
      expect.objectContaining({ id: "folder-project" })
    );
    expect(desktopApi.createProject).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a successful folder project in the replacement library", async () => {
    desktopApi.createProject
      .mockResolvedValueOnce(createdFolderDummyProject)
      .mockResolvedValueOnce({
        ...createdFolderDummyProject,
        id: "replacement-folder"
      });
    const create = await loadCreateLocalFolderDummyProjectOnce();
    const { rendererLibrary } = await import("@/platform/rendererLibraryWork");
    const original = rendererLibrary.capture();
    await expect(create("local", original)).resolves.toMatchObject({
      id: "folder-project"
    });
    await rendererLibrary.suspend();
    rendererLibrary.reset();
    await expect(create("local", original)).rejects.toMatchObject({
      name: "AbortError"
    });
    await expect(create("local")).resolves.toMatchObject({
      id: "replacement-folder"
    });
    expect(desktopApi.createProject).toHaveBeenCalledTimes(2);
  });
});
