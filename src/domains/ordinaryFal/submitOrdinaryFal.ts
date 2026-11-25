import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import type {
  OrdinaryFalAccount,
  OrdinaryFalApi,
  OrdinaryFalJob,
  OrdinaryFalSubmitInput,
  OrdinaryFalSubmitResult
} from "../../../desktop/shared/ordinaryFal";

export class OrdinaryFalActionError extends Error {}

type WithoutId<T> = T extends { id: string } ? Omit<T, "id"> : never;
export type OrdinaryFalDraft = WithoutId<OrdinaryFalSubmitInput>;

/** There is deliberately no legacy renderer or account/payment callback here. */
export const submitOrdinaryFal = async ({
  id,
  work,
  profile,
  bridge,
  config,
  confirmedConfig,
  prepare,
  localProject
}: {
  id: string;
  work: RendererLibraryWork;
  profile?: AbortSignal;
  bridge?: Pick<OrdinaryFalApi, "submit" | "get">;
  config?: () => Promise<OrdinaryFalAccount | null>;
  confirmedConfig: OrdinaryFalAccount | null | undefined;
  prepare: (check: () => void) => Promise<OrdinaryFalDraft>;
  localProject: boolean;
}): Promise<{ job: OrdinaryFalJob } | { unconfirmedId: string }> => {
  const check = () => {
    work.check();
    profile?.throwIfAborted();
  };
  check();
  if (!bridge || !config)
    throw new OrdinaryFalActionError(
      "Direct fal is unavailable in this window."
    );
  if (!localProject)
    throw new OrdinaryFalActionError("Select a local project for direct fal.");

  if (!confirmedConfig)
    throw new OrdinaryFalActionError(
      "Configure fal in Settings → Providers first."
    );
  const expectedFal: OrdinaryFalAccount = {
    keychainAccount: confirmedConfig.keychainAccount,
    revision: confirmedConfig.revision
  };
  const checkConfig = async () => {
    const current = await runRendererLibraryRequest(work, () => {
      check();
      return config();
    });
    check();
    if (
      current?.keychainAccount !== expectedFal.keychainAccount ||
      current.revision !== expectedFal.revision
    )
      throw new OrdinaryFalActionError(
        "The fal account or configuration changed. Review Settings → Providers before confirming again."
      );
  };
  await checkConfig();
  const request = await prepare(check);
  await checkConfig();
  let result: OrdinaryFalSubmitResult;
  try {
    result = await runRendererLibraryRequest(work, () => {
      check();
      return bridge.submit({ request: { ...request, id }, expectedFal });
    });
  } catch {
    check();
    // The provider may already have accepted it. Look up the same UUID; never
    // issue another paid request or hand the input to a legacy renderer.
    const job = await runRendererLibraryRequest(work, () => {
      check();
      return bridge.get({ id });
    }).catch(() => null);
    check();
    return job ? { job } : { unconfirmedId: id };
  }
  check();
  if (result.status === "rejected")
    throw new OrdinaryFalActionError(result.message);
  return { job: result.job };
};

export const validateOrdinaryFalPrompt = (prompt: string) => {
  const value = prompt.trim();
  const maxPromptLength = 20_000;
  if (!value || value.length > maxPromptLength)
    throw new OrdinaryFalActionError(
      "Enter a prompt of up to 20,000 characters."
    );
  return value;
};
