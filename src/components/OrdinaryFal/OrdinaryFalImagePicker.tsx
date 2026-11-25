import { FileDropZone } from "@components/FileDropZone";
import { useProject } from "@domains/project/useProject";
import { useMountEffect } from "@hooks/useMountEffect";
import { useRef, useState } from "react";

import { importLocalFalStill } from "@/domains/ordinaryFal/localFalImages";
import { OrdinaryFalActionError } from "@/domains/ordinaryFal/submitOrdinaryFal";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

const IMAGE_TYPES = ["image/jpeg", "image/png"];
const MAX_FILE_BYTES = 50_000_000;
const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the still"));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Use the ordinary local import, but its prepared-image variant never starts
 * automatic caption inference. No upload occurs until an explicit fal submit. */
export const OrdinaryFalImagePicker = ({
  projectId,
  text,
  value,
  onChange,
  maxFileUpload,
  onImportingChange
}: {
  projectId?: string;
  text: string;
  value: string[];
  onChange: (ids: string[]) => void;
  maxFileUpload: number;
  onImportingChange?: (importing: boolean) => void;
}) => {
  const { data: project } = useProject(projectId);
  const { work } = useRendererLibraryWork();
  const pending = useRef(false);
  const [importing, setImporting] = useState(false);
  const mounted = useRef(false);
  useMountEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  });
  const [error, setError] = useState<string>();
  const select = async (files: File[]) => {
    if (
      !projectId ||
      project?.origin !== "local" ||
      pending.current ||
      work.signal.aborted
    )
      return;
    const profile = captureRendererAccountProfile();
    if (profile?.aborted) return;
    const check = () => {
      work.check();
      profile?.throwIfAborted();
      if (!mounted.current)
        throw new DOMException("Image picker closed", "AbortError");
    };
    if (files.length + value.length > maxFileUpload) {
      setError(`Select at most ${maxFileUpload} images.`);
      return;
    }
    if (files.some((file) => file.size > MAX_FILE_BYTES)) {
      setError("Select JPEG or PNG images up to 50 MB each.");
      return;
    }
    pending.current = true;
    setImporting(true);
    onImportingChange?.(true);
    setError(undefined);
    const ids = [...value];
    try {
      const { assets } = getLocalDesktopApi();
      for (const file of files) {
        check();
        const dataUrl = await readAsDataUrl(file);
        const { baseAssetId } = await importLocalFalStill({
          assets,
          projectId,
          dataUrl,
          file,
          work,
          check
        });
        ids.push(baseAssetId);
      }
    } catch (cause) {
      if (mounted.current && !work.signal.aborted && !profile?.aborted) {
        setError(
          cause instanceof OrdinaryFalActionError
            ? cause.message
            : "Could not import the selected stills."
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current && !work.signal.aborted && !profile?.aborted) {
        if (ids.length > value.length) onChange(ids);
        setImporting(false);
        onImportingChange?.(false);
      }
    }
  };

  if (project?.origin !== "local" || work.signal.aborted) return null;
  if (importing)
    return (
      <p role="status" className="text-xs">
        Importing stills into this project…
      </p>
    );
  return (
    <div>
      <FileDropZone
        text={text}
        acceptedFileTypes={IMAGE_TYPES}
        value={value}
        onChange={onChange}
        maxFileUpload={maxFileUpload}
        onFilesSelected={(files) => void select(files)}
      />
      {error && (
        <p role="status" className="text-xs text-glyph-secondary">
          {error}
        </p>
      )}
    </div>
  );
};
