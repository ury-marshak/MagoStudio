import { useProject } from "@domains/project/useProject";
import { useFalProviderConfig } from "@domains/scriptProject/useFalProviderConfigured";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";
import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";

import type { OrdinaryFalJob } from "../../../desktop/shared/ordinaryFal";

import { OrdinaryFalActionError, submitOrdinaryFal } from "./submitOrdinaryFal";

export const ordinaryFalJobsKey = (projectId: string) =>
  ["ordinaryFal", "jobs", projectId] as const;
export const ORDINARY_FAL_POLL_MS = 3000;

export const useOrdinaryFalAction = (projectId: string | undefined) => {
  const scope = useRendererLibraryQueryScope();
  const client = useQueryClient();
  const desktop = typeof window === "undefined" ? undefined : window.mago;
  const bridge = desktop?.ordinaryFal;
  const { data: project } = useProject(projectId);
  const localProject = project?.origin === "local";
  const config = useFalProviderConfig(!!bridge && localProject);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [unconfirmedId, setUnconfirmedId] = useState<string>();
  const lookup = useQuery({
    queryKey: scope.key(["ordinaryFal", "get", unconfirmedId]),
    enabled: !!bridge && !!unconfirmedId && scope.active,
    queryFn: () =>
      scope.run(async () => {
        const profile = captureRendererAccountProfile();
        profile?.throwIfAborted();
        const job = await bridge!.get({ id: unconfirmedId! });
        profile?.throwIfAborted();
        scope.work.check();
        if (job && projectId)
          void client.invalidateQueries({
            queryKey: scope.key(ordinaryFalJobsKey(projectId))
          });
        return job;
      }),
    refetchInterval: (query) =>
      query.state.data ? false : ORDINARY_FAL_POLL_MS,
    retry: false
  });
  const unresolved = unconfirmedId && !lookup.data;
  const disabledReason =
    !scope.active || !bridge
      ? "Direct fal is unavailable in this window."
      : !localProject
        ? "Select a local project for direct fal."
        : config.isPending
          ? "Checking fal configuration…"
          : !config.data || config.isError
            ? "Configure fal in Settings → Providers."
            : undefined;

  const run = async (
    prepare: Parameters<typeof submitOrdinaryFal>[0]["prepare"]
  ) => {
    if (pending.current || unresolved || disabledReason || !projectId) return;
    const profile = captureRendererAccountProfile();
    if (profile?.aborted) return;
    pending.current = true;
    setBusy(true);
    setMessage(undefined);
    setUnconfirmedId(undefined);
    try {
      const result = await submitOrdinaryFal({
        id: crypto.randomUUID(),
        work: scope.work,
        profile,
        bridge,
        confirmedConfig: config.data,
        config:
          desktop?.externalProviders?.fal &&
          (() => desktop.externalProviders.fal.get()),
        prepare,
        localProject
      });
      scope.work.check();
      profile?.throwIfAborted();
      const key = scope.key(ordinaryFalJobsKey(projectId));
      if ("unconfirmedId" in result) {
        setUnconfirmedId(result.unconfirmedId);
      } else {
        const { job } = result;
        client.setQueryData<OrdinaryFalJob[]>(key, (jobs) =>
          jobs?.some((entry) => entry.id === job.id)
            ? jobs
            : [job, ...(jobs ?? [])]
        );
      }
      void client.invalidateQueries({ queryKey: key });
    } catch (error) {
      if (scope.active && !scope.work.signal.aborted && !profile?.aborted) {
        setMessage(
          error instanceof OrdinaryFalActionError
            ? error.message
            : "Could not prepare the direct fal request. Check the selected images and try again."
        );
      }
    } finally {
      pending.current = false;
      if (!scope.work.signal.aborted && !profile?.aborted) setBusy(false);
    }
  };

  return {
    run,
    busy,
    disabled: !!disabledReason || busy || !!unresolved,
    message: unresolved
      ? `Submission not confirmed. Checking job ${unconfirmedId}; do not generate again until its status is known.`
      : (message ?? disabledReason),
    projectDefaults: project?.settings?.fal_generation_settings,
    appDefaults: config.data?.generationSettings
  };
};
