import { describe, expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

import type {
  OrdinaryFalAccount,
  OrdinaryFalJob,
  OrdinaryFalSubmitInput,
  OrdinaryFalSubmitRequest,
  OrdinaryFalSubmitResult
} from "../../../desktop/shared/ordinaryFal";

import { OrdinaryFalActionError, submitOrdinaryFal } from "./submitOrdinaryFal";

const image: OrdinaryFalSubmitInput = {
  id: "12345678-1234-4234-8234-123456789abc",
  kind: "image-edit",
  model: "fal_nano_banana_2",
  projectId: "project",
  shotId: "shot",
  prompt: "Edit this still",
  baseAssetId: "local-still",
  referenceAssetIds: ["first", "second"],
  frame: 12,
  canvas: { width: 960, height: 540 }
};
const accepted: OrdinaryFalJob = {
  id: image.id,
  projectId: image.projectId,
  shotId: image.shotId,
  kind: image.kind,
  model: image.model,
  status: "SUBMITTED",
  placement: "PENDING",
  assetIds: [],
  clipId: null,
  error: null
};
const expectedFal = { keychainAccount: "fal", revision: "config-a" };
const acknowledgement: OrdinaryFalSubmitResult = {
  status: "job",
  job: accepted
};

const setup = () => {
  const session = new RendererLibrarySession();
  const profile = new AbortController();
  const importStill = vi.fn(async () => image.baseAssetId);
  const prepare = vi.fn(async () => ({
    ...image,
    baseAssetId: await importStill()
  }));
  const submit = vi.fn(
    async (
      _input: OrdinaryFalSubmitRequest
    ): Promise<OrdinaryFalSubmitResult> => acknowledgement
  );
  const get = vi.fn(
    async (_input: { id: string }): Promise<OrdinaryFalJob | null> => accepted
  );
  const config = vi.fn<() => Promise<OrdinaryFalAccount | null>>(
    async () => expectedFal
  );
  return {
    session,
    profile,
    prepare,
    importStill,
    submit,
    get,
    config,
    run: (
      bridge = { submit, get },
      localProject = true,
      confirmedConfig: OrdinaryFalAccount | null = expectedFal
    ) =>
      submitOrdinaryFal({
        confirmedConfig,
        id: image.id,
        work: session.capture(),
        profile: profile.signal,
        bridge,
        config,
        prepare,
        localProject
      })
  };
};

describe("explicit ordinary fal submission", () => {
  it("uses only the configured desktop bridge with ordered local asset IDs, without a Mago account", async () => {
    const { run, importStill, submit, get } = setup();
    await expect(run()).resolves.toEqual({ job: accepted });
    expect(importStill).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      request: image,
      expectedFal
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("does not prepare or dispatch when unconfigured or the project is cloud-owned", async () => {
    const { run, prepare, submit, config } = setup();
    config.mockResolvedValue(null);
    await expect(run(undefined, true, null)).rejects.toThrow("Configure fal");
    await expect(run(undefined, false)).rejects.toThrow("local project");
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not prepare when the dedicated bridge is missing", async () => {
    const { session, config, prepare } = setup();
    await expect(
      submitOrdinaryFal({
        id: image.id,
        work: session.capture(),
        config,
        confirmedConfig: expectedFal,
        prepare,
        localProject: true
      })
    ).rejects.toThrow("unavailable");
    expect(config).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("checks the same ID after losing acknowledgment without submitting again", async () => {
    const { run, submit, get } = setup();
    submit.mockRejectedValueOnce(new Error("disconnected"));
    await expect(run()).resolves.toEqual({ job: accepted });
    expect(get).toHaveBeenCalledExactlyOnceWith({ id: image.id });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("surfaces a definite validation rejection without polling and allows a corrected attempt", async () => {
    const { run, submit, get } = setup();
    submit.mockResolvedValueOnce({
      status: "rejected",
      message: "Select the entire source video"
    });
    await expect(run()).rejects.toThrow(OrdinaryFalActionError);
    expect(get).not.toHaveBeenCalled();
    await expect(run()).resolves.toEqual({ job: accepted });
  });

  it("keeps an unconfirmed ID when the status lookup cannot verify submission", async () => {
    const { run, submit, get } = setup();
    submit.mockRejectedValueOnce(new Error("disconnected"));
    get.mockResolvedValueOnce(null);
    await expect(run()).resolves.toEqual({ unconfirmedId: image.id });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not dispatch prepared input across a library replacement with reused IDs", async () => {
    const { run, session, prepare, submit } = setup();
    prepare.mockImplementationOnce(async () => {
      await session.suspend();
      session.reset();
      return image;
    });
    await expect(run()).rejects.toThrow("Library changed");
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { ...expectedFal, keychainAccount: "different" },
    { ...expectedFal, revision: "config-b" }
  ])(
    "does not submit if configuration changes during preparation",
    async (replacement) => {
      const { run, config, prepare, submit } = setup();
      config
        .mockResolvedValueOnce(expectedFal)
        .mockResolvedValueOnce(replacement);
      await expect(run()).rejects.toThrow(
        "The fal account or configuration changed"
      );
      expect(prepare).toHaveBeenCalledOnce();
      expect(submit).not.toHaveBeenCalled();
    }
  );

  it("checks the confirmed metadata against a fresh read before doing local preparation", async () => {
    const { run, config, prepare, submit } = setup();
    config.mockResolvedValue({ ...expectedFal, revision: "config-b" });
    await expect(run()).rejects.toThrow(
      "The fal account or configuration changed"
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not publish or retry an acknowledged job after profile retirement", async () => {
    const { run, profile, submit, get } = setup();
    submit.mockImplementationOnce(async () => {
      profile.abort();
      return acknowledgement;
    });
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(submit).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not prepare after the originating profile retires during configuration", async () => {
    const { run, profile, config, prepare, submit } = setup();
    config.mockImplementationOnce(async () => {
      profile.abort();
      return expectedFal;
    });
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
