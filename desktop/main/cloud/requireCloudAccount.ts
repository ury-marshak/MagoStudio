import type { LibrarySettings } from "../librarySettings";

export class CloudAccountRequiredError extends Error {
  constructor() {
    super("This operation requires an explicit cloud account choice");
    this.name = "CloudAccountRequiredError";
  }
}

/**
 * Renderer identity, a signed URL and historical project origin are not main-
 * process authorization. Only the user's persisted cloud-account choice allows
 * Mago cloud transfers. Local metadata/cached media remain account-free.
 * Recheck at dispatch after asynchronous preparation and on every redirect.
 */
export const requireCloudAccount = async (
  settings: Pick<LibrarySettings, "getAppMode">
): Promise<void> => {
  if ((await settings.getAppMode()) !== "cloud") {
    throw new CloudAccountRequiredError();
  }
};
