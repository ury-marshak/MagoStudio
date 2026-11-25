import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { useProject } from "@domains/project/useProject";
import { LayerType } from "@schemas/layer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from "@testing-library/react";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { DatabaseManager } from "../../../desktop/main/database/databaseManager";
import { ProjectRepository } from "../../../desktop/main/database/projectRepository";
import {
  assets,
  clips,
  externalRenderJobs,
  ordinaryFalJobs,
  projectAssets,
  projects,
  shots,
  tracks
} from "../../../desktop/main/database/schema";
import { OrdinaryFalRepository } from "../../../desktop/main/ordinaryFal/ordinaryFalRepository";
import { OrdinaryFalService } from "../../../desktop/main/ordinaryFal/ordinaryFalService";
import {
  FAL_KLING_EDIT,
  FAL_TOPAZ_UPSCALE
} from "../../../desktop/shared/ordinaryFal";

import { VideoEffectsHistoryButton } from "./VideoEffectsHistoryButton";

const presentationSignature = `pts-us-v1:${"a".repeat(64)}`;

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  nativeImage: {}
}));
vi.mock(
  "../../../desktop/main/ordinaryFal/probeEffectVideo",
  async (original) => ({
    ...(await original<
      typeof import("../../../desktop/main/ordinaryFal/probeEffectVideo")
    >()),
    probeEffectVideo: async () => ({ presentationSignature })
  })
);
vi.mock("@/platform/localDesktop", async (original) => ({
  ...(await original<typeof import("@/platform/localDesktop")>()),
  isLocalApp: true
}));
vi.mock("@components/Modal", () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { kind: "video-edit", model: FAL_KLING_EDIT, scale: 1, removed: false },
  { kind: "video-upscale", model: FAL_TOPAZ_UPSCALE, scale: 2, removed: false },
  { kind: "video-upscale", model: FAL_TOPAZ_UPSCALE, scale: 2, removed: true }
] as const)(
  "refreshes the real renderer project query after $kind placement (source removed: $removed)",
  async ({ kind, model, scale, removed }) => {
    const root = await mkdtemp(path.join(tmpdir(), "mago-effect-placement-"));
    const manager = new DatabaseManager();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    try {
      await manager.open(root);
      const projectId = "project";
      const shotId = "shot";
      const sourceTrackId = "source-track";
      const sourceClipId = "source-clip";
      const sourceAssetId = "source-asset";
      const outputAssetId = "output-asset";
      const jobId = `ordinary-fal:${crypto.randomUUID()}`;
      const db = manager.get();
      const source = {
        durationSeconds: 4,
        width: 1280,
        height: 720,
        fps: 24,
        hasAudio: false,
        sizeBytes: 10,
        presentationSignature
      };
      const asset = {
        type: "video",
        duration: 4000,
        fps: 24000,
        frameCount: 96
      };
      await db.insert(projects).values({
        id: projectId,
        name: "Project",
        settingsJson: '{"origin":"local"}'
      });
      await db.insert(shots).values({ id: shotId, projectId, name: "Shot" });
      await db.insert(tracks).values({
        id: sourceTrackId,
        projectId,
        shotId,
        name: "Source",
        type: "IMAGE"
      });
      await db.insert(assets).values([
        {
          ...asset,
          id: sourceAssetId,
          name: "Source",
          sourcePath: path.join(root, "source.mov"),
          width: source.width,
          height: source.height
        },
        {
          ...asset,
          id: outputAssetId,
          name: "Effect output",
          dataJson: '{"hasAudio":false}',
          sourcePath: path.join(root, "output.mp4"),
          width: source.width * scale,
          height: source.height * scale
        }
      ]);
      await db.insert(projectAssets).values([
        { projectId, assetId: sourceAssetId },
        { projectId, assetId: outputAssetId }
      ]);
      await db.insert(clips).values({
        id: sourceClipId,
        trackId: sourceTrackId,
        assetId: sourceAssetId,
        name: "Source",
        timelineOffset: 1000
      });
      await db.insert(ordinaryFalJobs).values({
        jobId,
        projectId,
        shotId,
        model,
        kind,
        keychainAccount: "fixture-only",
        inputDigest: "fixture",
        destination: {
          kind,
          sourceClipId,
          sourceAssetId,
          sourceTrackId,
          startFrame: 24,
          frameCount: 96,
          source
        },
        effectiveSettings: {}
      });
      await db.insert(externalRenderJobs).values({
        id: jobId,
        projectId,
        provider: "fal",
        endpoint: "fixture",
        kind: "video",
        keychainAccount: "fixture-only",
        status: "INGESTED",
        requestJson: {},
        inputAssetIds: [sourceAssetId],
        outputJson: { urls: [], assetIds: [outputAssetId] }
      });

      const repository = new OrdinaryFalRepository(manager);
      const projectRepository = new ProjectRepository(
        manager,
        async () => root
      );
      const owner = new AbortController();
      const getFal = vi.fn(async () => null);
      const readKey = vi.fn(async () => {
        throw new Error("Unexpected credential read");
      });
      const fetch = vi.fn(async () => {
        throw new Error("Unexpected network request");
      });
      const service = new OrdinaryFalService({
        databaseManager: manager,
        captureProfile: () => owner.signal,
        getLibraryRoot: async () => root,
        getFal,
        readKey
      });
      vi.stubGlobal("fetch", fetch);
      vi.stubGlobal("mago", {
        library: { onWillChange: async () => {}, onDidChange: () => {} },
        projects: { get: (id: string) => projectRepository.get(id) },
        ordinaryFal: {
          list: (input: { projectId: string }) =>
            service.list(input, owner.signal)
        }
      });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(() => useProject(projectId), { wrapper });
      const layers = () => result.current.data?.timelines?.[0]?.layers;
      await waitFor(() =>
        expect(layers()?.map(({ id }) => id)).toEqual([sourceTrackId])
      );
      const original = layers()?.[0];

      if (removed) await db.delete(tracks).where(eq(tracks.id, sourceTrackId));
      await repository.attach((await repository.get(jobId))!, owner.signal);
      expect((await repository.get(jobId))?.editor.placement).toBe(
        removed ? "UNATTACHED" : "ATTACHED"
      );
      render(<VideoEffectsHistoryButton projectId={projectId} />, { wrapper });
      fireEvent.click(
        await screen.findByRole("button", { name: "Video effects history" })
      );
      expect(
        await screen.findByLabelText("Local video effect result")
      ).toHaveAttribute("src", `mago-media://asset/${outputAssetId}`);
      if (removed) {
        await waitFor(() => expect(layers()).toEqual([]));
        expect(screen.getByText(/not attached to the timeline/)).toBeVisible();
      } else {
        await waitFor(() => expect(layers()).toHaveLength(2));
        expect(layers()?.[0]).toEqual(original);
        expect(layers()?.[1]).toMatchObject({
          type: LayerType.RENDER,
          data: { externalRender: { provider: "fal", kind } },
          clips: [
            {
              asset_id: outputAssetId,
              data: {
                timeline_offset: 24,
                duration: 96,
                frame_range: [24, 120]
              }
            }
          ]
        });
        expect(layers()?.[1]?.data.renderEngine).toBeUndefined();
      }
      expect(getFal).not.toHaveBeenCalled();
      expect(readKey).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
      client.clear();
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
