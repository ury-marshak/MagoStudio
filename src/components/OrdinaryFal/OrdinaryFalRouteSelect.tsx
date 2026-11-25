import { useState } from "react";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

export const useOrdinaryFalRoute = (projectId: string | undefined) => {
  const { libraryVersion } = useRendererLibraryWork();
  const scope = JSON.stringify([libraryVersion, projectId]);
  const [selected, select] = useState(false);
  return {
    scope,
    selected,
    available: typeof window !== "undefined" && !!window.mago?.ordinaryFal,
    select
  };
};

export const OrdinaryFalRouteSelect = ({
  selected,
  select,
  disabled
}: {
  selected: boolean;
  select: (enabled: boolean) => void;
  disabled?: boolean;
}) => (
  <label className="flex flex-col gap-1 text-xs">
    Render route
    <select
      className="rounded-md border border-element-primary bg-transparent p-2"
      value={selected ? "fal" : "standard"}
      disabled={disabled}
      onChange={(event) => select(event.target.value === "fal")}
    >
      <option value="standard">Standard editor models</option>
      <option value="fal">fal (direct)</option>
    </select>
  </label>
);
