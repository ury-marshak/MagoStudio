import { readFile } from "node:fs/promises";

import { nativeImage } from "electron";

import type {
  LocalAsset,
  LocalAssetPromptResult,
  LocalAutoPromptInput,
  LocalAutoPromptResult,
  LocalAutoPromptSaveInput,
  LocalEnhancePromptInput,
  LocalEnhancePromptResult,
  VlmModelStatus
} from "../../shared/contracts";
import type { ProjectRepository } from "../database/projectRepository";
import { clearLibraryIssue, reportLibraryIssue } from "../libraryHealth";
import { LibraryWorkSession } from "../libraryWorkSession";
import {
  SharedInference,
  waitForInference
} from "../providers/sharedInference";
import {
  createReferenceGrid,
  extractMetricsFrameGrid
} from "../scriptProjects/localScriptMedia";

import {
  extractJsonObject,
  readCachedPrompt,
  toPositivePrompt,
  toStructuredPrompt,
  type StructuredPrompt
} from "./promptJson";
import { AUTO_PROMPT_IMG2IMG } from "./prompts/autoPromptImg2Img";
import { AUTO_PROMPT_VIDEO2VIDEO } from "./prompts/autoPromptVideo2Video";
import { entityDescriptionPrompt } from "./prompts/entityDescription";
import { IMAGE_DESCRIPTION_PROMPT } from "./prompts/imageDescription";
import { PROMPT_ENHANCER_KONTEXT } from "./prompts/promptEnhancerKontext";
import { STYLE_REFERENCE_PROMPT } from "./prompts/styleReference";
import { VIDEO_DESCRIPTION_PROMPT } from "./prompts/videoDescription";
import { extractVideoCaptionFrames } from "./videoFrames";
import {
  buildVideoMetricsPrompt,
  parseVideoMetrics,
  sampleMetricsTimestamps,
  type ShotVideoEvaluationInput
} from "./videoMetrics";
import type { VisionGenerator, VisionRequest } from "./visionGenerator";

/** Reference images are downscaled to this before they reach the VLM, matching
 *  AUTO_PROMPT_IMAGE_MAX_DIMENSION in the renderer. */
const IMAGE_MAX_DIMENSION = 1024;

const SYSTEM_PROMPT =
  "You are a precise visual analysis assistant. Follow the user's output " +
  "format exactly and never add commentary outside it.";

/** Captions are structured JSON and can be long; AutoPrompt is a sentence. */
const CAPTION_MAX_TOKENS = 1400;
/** Entity and plain-image descriptions are both two or three sentences. */
const DESCRIPTION_MAX_TOKENS = 384;
const AUTO_PROMPT_MAX_TOKENS = 512;
const ENHANCE_MAX_TOKENS = 512;
const METRICS_FRAMES_PER_GRID = 4;

const storedDescription = (asset: LocalAsset): string | null =>
  typeof asset.data.description === "string" ? asset.data.description : null;

type GenerateRequest = Omit<VisionRequest, "systemPrompt">;

export class VlmService {
  /** Maps and serialization belong to a library, not to reused asset IDs. */
  readonly libraryWork = new LibraryWorkSession(() => ({
    pending: new SharedInference<LocalAssetPromptResult>(),
    pendingDescriptions: new SharedInference<string | null>(),
    queue: Promise.resolve() as Promise<unknown>,
    profiles: new WeakMap<
      AbortSignal,
      {
        pending: SharedInference<LocalAssetPromptResult>;
        pendingDescriptions: SharedInference<string | null>;
        queue: Promise<unknown>;
      }
    >()
  }));

  stop(): void {
    this.libraryWork.stop();
  }

  suspend(): Promise<void> {
    return this.libraryWork.suspend();
  }

  reset(): void {
    this.libraryWork.reset();
  }

  private profileState(profile?: AbortSignal) {
    if (!profile) return this.libraryWork.state;
    profile.throwIfAborted();
    const { profiles } = this.libraryWork.state;
    let state = profiles.get(profile);
    if (!state) {
      state = {
        pending: new SharedInference<LocalAssetPromptResult>(),
        pendingDescriptions: new SharedInference<string | null>(),
        queue: Promise.resolve()
      };
      profiles.set(profile, state);
    }
    return state;
  }

  private signalForProfile(
    caller?: AbortSignal,
    profile = this.captureProfile?.()
  ) {
    return this.signal(
      caller && profile
        ? AbortSignal.any([caller, profile])
        : (caller ?? profile)
    );
  }

  private signal(caller?: AbortSignal): AbortSignal {
    caller?.throwIfAborted();
    const lifetime = this.libraryWork.signal;
    const signal = caller ? AbortSignal.any([caller, lifetime]) : lifetime;
    signal.throwIfAborted();
    return signal;
  }

  constructor(
    private readonly repository: ProjectRepository,
    private readonly generateVision: VisionGenerator,
    private readonly probeVision: (
      signal?: AbortSignal
    ) => Promise<VlmModelStatus>,
    private readonly generateEnhancement: VisionGenerator = generateVision,
    private readonly captureProfile?: () => AbortSignal
  ) {
    this.repository = this.libraryWork.guard(repository);
    this.status = this.libraryWork.bind(this.status.bind(this));
    this.captionAsset = this.libraryWork.bind(this.captionAsset.bind(this));
    this.describeImageAsset = this.libraryWork.bind(
      this.describeImageAsset.bind(this)
    );
    this.describeEntityImage = this.libraryWork.bind(
      this.describeEntityImage.bind(this)
    );
    this.evaluateShotVideo = this.libraryWork.bind(
      this.evaluateShotVideo.bind(this)
    );
    this.autoPrompt = this.libraryWork.bind(this.autoPrompt.bind(this));
    this.saveAutoPrompt = this.libraryWork.bind(this.saveAutoPrompt.bind(this));
    this.enhancePrompt = this.libraryWork.bind(this.enhancePrompt.bind(this));
  }

  status(caller?: AbortSignal): Promise<VlmModelStatus> {
    const profile = this.captureProfile?.();
    const signal = this.signalForProfile(caller, profile);
    return waitForInference(this.probeVision(signal), signal);
  }

  async captionAsset(
    assetId: string,
    caller?: AbortSignal
  ): Promise<LocalAssetPromptResult> {
    if (!assetId) throw new Error("Asset ID is required");
    const profile = this.captureProfile?.();
    return this.profileState(profile).pending.run(
      assetId,
      (signal) =>
        this.generateAssetPrompt(
          assetId,
          this.signalForProfile(signal, profile)
        ),
      this.signalForProfile(caller, profile)
    );
  }

  /**
   * Describe the entity depicted by one script-project reference sheet.
   * Unlike `captionAsset`, this deliberately ignores the sheet layout and
   * returns plain prose suitable for MiniMax's reference inventory.
   */
  async describeEntityImage(
    sourcePath: string,
    kind: string,
    generate?: VisionGenerator,
    caller?: AbortSignal,
    profile = this.captureProfile?.()
  ): Promise<string> {
    const signal = this.signalForProfile(caller, profile);
    const request = entityDescriptionPrompt(kind);
    const description = await this.generate(
      {
        userPrompt: request.prompt,
        signal,
        images: [await this.loadImage(sourcePath)],
        maxTokens: DESCRIPTION_MAX_TOKENS,
        temperature: 0.1
      },
      generate
    );
    if (!description)
      throw new Error("Vision model returned an empty description");
    return description;
  }

  /** Same judge contract as the backend, using the configured local VLM. */
  async evaluateShotVideo(
    input: ShotVideoEvaluationInput,
    caller?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const signal = this.signalForProfile(caller);
    const timestamps = sampleMetricsTimestamps(input.durationSeconds);
    const images: Buffer[] = [];
    if (input.referencePaths.length) {
      images.push(
        input.referencePaths.length === 1
          ? await this.loadImage(input.referencePaths[0]!)
          : this.resize(
              await this.libraryWork.boundary(() =>
                createReferenceGrid(input.referencePaths, signal)
              )
            )
      );
    }
    for (
      let index = 0;
      index < timestamps.length;
      index += METRICS_FRAMES_PER_GRID
    ) {
      images.push(
        await this.libraryWork.boundary(() =>
          extractMetricsFrameGrid(
            input.sourcePath,
            timestamps.slice(index, index + METRICS_FRAMES_PER_GRID),
            input.durationSeconds,
            signal
          )
        )
      );
    }
    const { text, model } = await this.complete({
      signal,
      userPrompt: buildVideoMetricsPrompt(
        input.prompt,
        timestamps,
        input.referencePaths.length > 0
      ),
      images,
      maxTokens: 2048,
      temperature: 0.1
    });
    return {
      ...parseVideoMetrics(text),
      model,
      frame_count: timestamps.length,
      source_analysis: null,
      ref_assets_loaded: input.referencePaths.length
    };
  }

  /**
   * An image asset's `description` — the backend's image description
   * without a kind: plain prose about the picture, not a reference sheet's
   * entity. Generated once and stored; an existing description, including one
   * the user cleared to blank, is returned as is and never regenerated.
   *
   * Resolves to null for a non-image, or an image whose file is not available.
   */
  async describeImageAsset(
    assetId: string,
    caller?: AbortSignal
  ): Promise<string | null> {
    if (!assetId) throw new Error("Asset ID is required");
    const profile = this.captureProfile?.();
    return this.profileState(profile).pendingDescriptions.run(
      assetId,
      (signal) =>
        this.generateImageDescription(
          assetId,
          this.signalForProfile(signal, profile)
        ),
      this.signalForProfile(caller, profile)
    );
  }

  /**
   * Describe a freshly uploaded or rendered image in the background. Never
   * throws and never blocks the upload or render that called it. Skipped while
   * the VLM is not installed; adaptation captions such an image on demand
   * later.
   */
  describeAssetLater(assetId: string, origin = this.libraryWork.signal): void {
    // Capture before the first readiness/cache await, including when a producer
    // supplies the lifetime it captured before ingestion. Expected teardown is
    // not a library-health failure and must not clear a replacement's issue.
    try {
      const profile = this.captureProfile?.();
      if (profile) origin = AbortSignal.any([origin, profile]);
    } catch {
      return;
    }
    if (origin.aborted) return;
    const id = `Image description ${assetId}`;
    void this.libraryWork
      .run(async () => {
        this.signal(origin);
        const status = await this.status(origin);
        this.signal(origin);
        if (status.ready) await this.describeImageAsset(assetId, origin);
      })
      .then(
        () => {
          if (!origin.aborted) clearLibraryIssue(id);
        },
        (error: unknown) => {
          if (!origin.aborted)
            reportLibraryIssue({
              id,
              kind: "service",
              message: `${id}: ${error instanceof Error ? error.message : String(error)}`
            });
        }
      );
  }

  async autoPrompt(
    input: LocalAutoPromptInput,
    caller?: AbortSignal
  ): Promise<LocalAutoPromptResult> {
    const signal = this.signalForProfile(caller);
    const style = this.decodeImage(input.styleReferenceImage);
    if (!style) throw new Error("styleReferenceImage is required");

    // Same preconditions the cloud endpoint enforces, checked
    // here so a bad call fails fast instead of after a minute of inference.
    if (input.version === "img2img_mago") {
      const source = this.decodeImage(input.sourceVideoFrame);
      if (!source)
        throw new Error("sourceVideoFrame is required for img2img_mago");
      // Order matters: the template calls the video frame "Image 1" and the
      // style reference "Image 2".
      return {
        positive_prompt: await this.generatePositive({
          userPrompt: AUTO_PROMPT_IMG2IMG,
          signal,
          images: [source, style],
          maxTokens: AUTO_PROMPT_MAX_TOKENS
        })
      };
    }

    const motionDescription = input.motionDescription?.trim();
    if (!motionDescription)
      throw new Error("motionDescription is required for video2video_default");
    return {
      positive_prompt: await this.generatePositive({
        userPrompt: `${AUTO_PROMPT_VIDEO2VIDEO}\n\nMotion description: ${motionDescription}`,
        signal,
        images: [style],
        maxTokens: AUTO_PROMPT_MAX_TOKENS
      })
    };
  }

  async saveAutoPrompt(
    input: LocalAutoPromptSaveInput
  ): Promise<LocalAsset | null> {
    const positivePrompt = input.positivePrompt.trim();
    if (!positivePrompt)
      throw new Error("positive_prompt must be a non-empty string");
    return this.repository.appendAssetAutoPrompt(input.assetId, {
      video_asset_id: input.videoAssetId,
      version: input.version,
      positive_prompt: positivePrompt
    });
  }

  async enhancePrompt(
    input: LocalEnhancePromptInput,
    caller?: AbortSignal
  ): Promise<LocalEnhancePromptResult> {
    const signal = this.signalForProfile(caller);
    const query = input.query?.trim();
    if (!query) throw new Error("Missing required 'query' field");
    // Text only — the enhancer never had an image, and only the kontext version
    // ever shipped.
    const text = await this.generate(
      {
        userPrompt: `${PROMPT_ENHANCER_KONTEXT}\n\nUser prompt: ${query}`,
        signal,
        maxTokens: ENHANCE_MAX_TOKENS
      },
      this.generateEnhancement
    );
    return { enhanced_prompt: text };
  }

  private async generateImageDescription(
    assetId: string,
    signal: AbortSignal
  ): Promise<string | null> {
    signal.throwIfAborted();
    const asset = await this.repository.getAsset(assetId);
    signal.throwIfAborted();
    if (!asset || asset.type !== "IMAGE") return null;
    if ("description" in asset.data) return storedDescription(asset);

    const sourcePath = await this.repository.assetSourcePath(assetId);
    signal.throwIfAborted();
    if (!sourcePath) return null;
    const description = await this.generate({
      userPrompt: IMAGE_DESCRIPTION_PROMPT,
      signal,
      images: [await this.loadImage(sourcePath)],
      maxTokens: DESCRIPTION_MAX_TOKENS,
      temperature: 0.1
    });
    if (!description)
      throw new Error("Vision model returned an empty description");
    // Whatever landed first wins: a user edit made while Qwen was running is
    // kept, and that is what the caller gets back.
    signal.throwIfAborted();
    const updated = await this.repository.setAssetDescriptionIfAbsent(
      assetId,
      description
    );
    return updated ? storedDescription(updated) : description;
  }

  private async generateAssetPrompt(
    assetId: string,
    signal: AbortSignal
  ): Promise<LocalAssetPromptResult> {
    signal.throwIfAborted();
    const asset = await this.repository.getAsset(assetId);
    signal.throwIfAborted();
    if (!asset) throw new Error("Local asset not found");

    const cached = readCachedPrompt(asset.data.prompt);
    if (cached) return { prompt: cached };

    const prompt =
      asset.type === "IMAGE"
        ? await this.captionImage(assetId, signal)
        : await this.captionVideo(assetId, asset, signal);

    signal.throwIfAborted();
    await this.repository.setAssetPrompt(
      assetId,
      prompt as unknown as Record<string, unknown>
    );
    return { prompt };
  }

  private async captionImage(
    assetId: string,
    signal: AbortSignal
  ): Promise<StructuredPrompt> {
    signal.throwIfAborted();
    const sourcePath = await this.repository.assetSourcePath(assetId);
    signal.throwIfAborted();
    if (!sourcePath) throw new Error("Asset file is unavailable");
    const image = await this.loadImage(sourcePath);
    return this.generateStructured({
      userPrompt: STYLE_REFERENCE_PROMPT,
      signal,
      images: [image],
      maxTokens: CAPTION_MAX_TOKENS
    });
  }

  private async captionVideo(
    assetId: string,
    asset: LocalAsset,
    signal: AbortSignal
  ): Promise<StructuredPrompt> {
    signal.throwIfAborted();
    const sourcePath = await this.repository.assetSourcePath(assetId);
    signal.throwIfAborted();
    if (!sourcePath) throw new Error("Asset file is unavailable");
    const totalFrames = Number(asset.data.total_frames) || 0;
    if (totalFrames < 1)
      throw new Error("Video asset has no frame count to sample from");
    const { firstFrame, grids } = await this.libraryWork.boundary(() =>
      extractVideoCaptionFrames({ sourcePath, signal, totalFrames })
    );
    return this.generateStructured({
      userPrompt: VIDEO_DESCRIPTION_PROMPT,
      signal,
      images: [firstFrame, ...grids],
      maxTokens: CAPTION_MAX_TOKENS
    });
  }

  private async generateStructured(
    request: GenerateRequest
  ): Promise<StructuredPrompt> {
    const { parsed } = await this.generateParsed(request, (text) =>
      toStructuredPrompt(extractJsonObject(text))
    );
    if (!parsed)
      throw new Error("Qwen3-VL did not return the expected JSON structure");
    return parsed;
  }

  private async generatePositive(request: GenerateRequest): Promise<string> {
    const { parsed, text } = await this.generateParsed(request, (value) =>
      toPositivePrompt(extractJsonObject(value))
    );
    // Fall back to the raw text: the AutoPrompt templates ask for
    // {"positive": "..."}, but a bare sentence is still a usable prompt and
    // beats handing the user nothing.
    return parsed ?? text;
  }

  /**
   * One generation, plus a single deterministic retry when the output can't be
   * parsed. A 2B model drifts off-format far more often than gemini-2.5-flash
   * did; temperature 0 with a blunter instruction usually snaps it back.
   */
  private async generateParsed<T>(
    request: GenerateRequest,
    parse: (text: string) => T | null
  ): Promise<{ parsed: T | null; text: string }> {
    const text = await this.generate(request);
    const parsed = parse(text);
    if (parsed !== null) return { parsed, text };

    const retryText = await this.generate({
      ...request,
      userPrompt: `${request.userPrompt}\n\nRespond with the JSON object only. No prose, no code fence.`,
      temperature: 0
    });
    return { parsed: parse(retryText), text: retryText };
  }

  private async generate(
    request: GenerateRequest,
    generate: VisionGenerator = this.generateVision
  ): Promise<string> {
    return (await this.complete(request, generate)).text;
  }

  private complete(request: GenerateRequest, generate = this.generateVision) {
    request.signal?.throwIfAborted();
    const profile = this.captureProfile?.();
    const signal = this.signalForProfile(request.signal, profile);
    const state = this.profileState(profile);
    const task = state.queue.then(async () => {
      signal.throwIfAborted();
      const { text, model } = await generate({
        systemPrompt: SYSTEM_PROMPT,
        ...request,
        signal
      });
      // Even a provider that resolves after abort must not trigger repair or writes.
      signal.throwIfAborted();
      return { text: text.trim(), model };
    });
    // Keep serialization within this session until the provider settles. A
    // replacement library gets a fresh queue even if that provider ignores abort.
    state.queue = task.then(
      () => undefined,
      () => undefined
    );
    return waitForInference(task, signal);
  }

  private async loadImage(sourcePath: string): Promise<Buffer> {
    return this.libraryWork.boundary(async () =>
      this.resize(await readFile(sourcePath))
    );
  }

  /** Decode a data URI (or bare base64) as the renderer sends it. Returns null
   *  only when the value is absent or empty — a present-but-undecodable image
   *  throws, so the caller doesn't report it as "missing". */
  private decodeImage(value: string | undefined): Buffer | null {
    if (!value) return null;
    const base64 = value.includes(",") ? value.split(",", 2)[1]! : value;
    const bytes = Buffer.from(base64, "base64");
    return bytes.length ? this.resize(bytes) : null;
  }

  /** Downscale to IMAGE_MAX_DIMENSION and normalise to PNG. */
  private resize(bytes: Buffer): Buffer {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("Could not decode the image");
    const { width, height } = image.getSize();
    const longest = Math.max(width, height);
    const scaled =
      longest > IMAGE_MAX_DIMENSION
        ? image.resize(
            width >= height
              ? { width: IMAGE_MAX_DIMENSION }
              : { height: IMAGE_MAX_DIMENSION }
          )
        : image;
    return scaled.toPNG();
  }
}
