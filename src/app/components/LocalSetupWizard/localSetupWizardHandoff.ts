import type { LocalModelGroupId } from "../../../../desktop/shared/localModelGroups";

export const OPEN_LOCAL_SETUP_EVENT = "mago:open-local-setup";

export type LocalSetupOpenRequest =
  | {
      kind: "update-installation";
      preselectedModelGroupIds: LocalModelGroupId[];
    }
  | { kind: "manual-download" };

const isLocalSetupOpenRequest = (
  detail: unknown
): detail is LocalSetupOpenRequest =>
  typeof detail === "object" &&
  detail !== null &&
  "kind" in detail &&
  (detail.kind === "update-installation" || detail.kind === "manual-download");

export const readLocalSetupOpenRequest = (
  event: Event
): LocalSetupOpenRequest | null =>
  event instanceof CustomEvent && isLocalSetupOpenRequest(event.detail)
    ? event.detail
    : null;
