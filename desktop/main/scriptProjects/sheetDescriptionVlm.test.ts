import { expect, it, vi } from "vitest";

import type { ProjectRepository } from "../database/projectRepository";
import type { VisionGenerator } from "../vlm/visionGenerator";
import { VlmService } from "../vlm/vlmService";

import { LocalScriptProjectService } from "./localScriptProjectService";

vi.mock("electron", () => ({ nativeImage: {} }));

const setup = (generate: VisionGenerator) => {
  const vlm = new VlmService({} as ProjectRepository, generate, vi.fn());
  vi.spyOn(
    vlm as unknown as { loadImage: (source: string) => Promise<Buffer> },
    "loadImage"
  ).mockResolvedValue(Buffer.from("fixture"));
  const state = {
    keys: [
      {
        token: "hero",
        name: "Hero",
        kind: "character",
        enabled: true,
        effective_asset_id: "image",
        seed_description: "seed",
        description: "seed",
        images: [{ asset_id: "image", has_description: false }]
      }
    ],
    shots: []
  };
  const put = vi.fn();
  const service = new LocalScriptProjectService(
    {
      get: async () => ({ origin: "local", type: "script_to_shots" })
    } as never,
    {
      get: async () => ({ state }),
      resolveMediaPath: async () => "fixture.png",
      put
    } as never,
    async () => "unused",
    undefined,
    (source, kind, signal) =>
      vlm.describeEntityImage(source, kind, undefined, signal)
  );
  const request = () =>
    service.update({
      projectId: "project",
      operation: "describe-sheet",
      payload: { token: "hero", assetId: "image" }
    });
  return { vlm, service, put, request };
};

it("skips a Director description queued behind VLM work after library teardown", async () => {
  let finish!: (result: { text: string; model: string }) => void;
  const generate = vi.fn<VisionGenerator>().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const test = setup(generate);
  const active = test.vlm.enhancePrompt({ query: "unrelated work" });
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  const description = test.request();
  const rejected = expect(description).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await test.service.suspendDescriptions();
  await rejected;
  finish({ text: "unrelated result", model: "mock" });
  await active;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(generate).toHaveBeenCalledTimes(1);
  expect(test.put).not.toHaveBeenCalled();
});

it.each(["late hero", "", "not JSON"])(
  "cannot persist or start a repair for aborted active description output %j",
  async (text) => {
    let finish!: (result: { text: string; model: string }) => void;
    const generate = vi.fn<VisionGenerator>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const test = setup(generate);
    const description = test.request();
    const rejected = expect(description).rejects.toThrow();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await test.service.suspendDescriptions();
    await rejected;
    expect(generate.mock.calls[0]![0].signal?.aborted).toBe(true);
    finish({ text, model: "mock" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(test.put).not.toHaveBeenCalled();
    // Entity descriptions are plain prose, not a structured/JSON repair workflow.
  }
);
