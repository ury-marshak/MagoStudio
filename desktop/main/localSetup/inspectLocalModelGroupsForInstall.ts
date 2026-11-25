import {
  findLocalModelGroup,
  pickHardwareVariantForVideoMemory,
  type LocalModelGroupId,
  type SelectedModelGroupVariants
} from "../../shared/localModelGroups";

import { inspectLocalModelGroups } from "./inspectLocalModelGroups";
import type { SetupAttempt } from "./setupAttempt";

export type LocalModelGroupsInstallInspection = Awaited<
  ReturnType<typeof inspectLocalModelGroups>
> & {
  selectedModelGroupVariantsForInstall: SelectedModelGroupVariants;
  hardwareVariantGroupIdsPickedForInstall: LocalModelGroupId[];
};

export const inspectLocalModelGroupsForInstall = async (
  settings: Parameters<typeof inspectLocalModelGroups>[0],
  readVideoMemoryBytes: () => Promise<number | null>,
  attempt?: SetupAttempt
): Promise<LocalModelGroupsInstallInspection> => {
  const savedModelGroupVariants =
    await settings.getSelectedModelGroupVariants();
  const savedInspection = await inspectLocalModelGroups(
    settings,
    undefined,
    attempt
  );
  const notInstalledHardwareVariantGroups = savedInspection.groups
    .filter((group) => group.state === "not-installed")
    .map((group) => findLocalModelGroup(group.groupId))
    .filter((group) => group.hardwareVariants !== undefined);
  if (notInstalledHardwareVariantGroups.length === 0)
    return {
      ...savedInspection,
      selectedModelGroupVariantsForInstall: savedModelGroupVariants,
      hardwareVariantGroupIdsPickedForInstall: []
    };
  attempt?.signal.throwIfAborted();
  const videoMemoryBytes = await readVideoMemoryBytes();
  attempt?.signal.throwIfAborted();
  const selectedModelGroupVariantsForInstall: SelectedModelGroupVariants = {
    ...savedModelGroupVariants
  };
  for (const group of notInstalledHardwareVariantGroups)
    selectedModelGroupVariantsForInstall[group.id] =
      pickHardwareVariantForVideoMemory(
        group.hardwareVariants ?? [],
        videoMemoryBytes
      );
  const isSameAsSavedSelection = notInstalledHardwareVariantGroups.every(
    (group) =>
      selectedModelGroupVariantsForInstall[group.id] ===
      savedModelGroupVariants[group.id]
  );
  const inspection = isSameAsSavedSelection
    ? savedInspection
    : await inspectLocalModelGroups(
        settings,
        selectedModelGroupVariantsForInstall,
        attempt
      );
  return {
    ...inspection,
    selectedModelGroupVariantsForInstall,
    hardwareVariantGroupIdsPickedForInstall:
      notInstalledHardwareVariantGroups.map((group) => group.id)
  };
};
