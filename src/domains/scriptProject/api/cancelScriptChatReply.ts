import { getLocalDesktopApi } from "@/platform/localDesktop";

import { isLocalScriptProject } from "../projectOrigin";

export type CancelScriptChatReplyRequest = {
  projectId: string;
  messageId: string;
};

/** Explicit desktop operation: never fall back to a cloud chat endpoint. */
export const cancelScriptChatReply = async (
  request: CancelScriptChatReplyRequest
): Promise<boolean> => {
  if (!(await isLocalScriptProject(request.projectId)))
    throw new Error("Chat cancellation is only available for local projects");
  return getLocalDesktopApi().scriptProjects.cancelChat(request);
};
