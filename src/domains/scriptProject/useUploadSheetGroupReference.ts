import { useUploadReferenceImage } from "@domains/asset/useUploadReferenceImage";
import { useTranslation } from "react-i18next";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { useReportScriptProjectFailure } from "./useReportScriptProjectFailure";
import { readUploadRejectionMessage } from "./utils/readUploadRejectionMessage";

export const useUploadSheetGroupReference = (projectId: string) => {
  const { t } = useTranslation();
  const reportScriptProjectFailure = useReportScriptProjectFailure();
  const { mutateAsync: uploadReferenceImage } = useUploadReferenceImage();

  const { work } = useRendererLibraryWork();

  return async (file: File): Promise<string | undefined> => {
    if (work.signal.aborted) return;
    let fileUploadFailure: unknown;
    try {
      const assetId = await uploadReferenceImage({
        file,
        projectId,
        work,
        onError: (error) => {
          fileUploadFailure = error;
        }
      });
      work.check();
      if (assetId) return assetId;
    } catch (error) {
      fileUploadFailure = error;
    }

    if (work.signal.aborted) return;
    const failure =
      fileUploadFailure instanceof Error
        ? fileUploadFailure
        : new Error("Reference image upload failed");
    reportScriptProjectFailure(
      failure,
      readUploadRejectionMessage(failure) ??
        t("script_project.upload_reference_failed.description")
    );
    return undefined;
  };
};
