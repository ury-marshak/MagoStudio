# External provider dependencies

This inventory reflects Mago Studio 0.19.3. The external-provider column tracks the migration from that baseline.

| Workflow | Current dependency | External-provider path |
| --- | --- | --- |
| Director script chat and script writing | `application.ts` calls `TextModelBridge` or Comfy Qwen. `LocalScriptChatService` parses tool responses and persists messages. | Desktop main can use configured OpenAI-compatible text generation with local parsing and project writes. Director availability gates are pending. |
| Director casting and shot prompts | `LocalScriptProjectService` delegates whole operations to the bridge or calls Qwen through the local casting and storyboard composers. Shot preparation currently happens in the Comfy render pipeline. | Local Director casting and shot prompt composition use configured external text generation. Separating shot preparation from video submission is pending. |
| Character body-plan classification | Reference-sheet completion runs a background Qwen text call in `LocalScriptProjectService`. | Use configured text generation or skip automatic classification when unavailable. Pending. |
| Optimize prompt for video | The renderer selects the legacy text route. The Mago path may mirror references. `LocalI2vPromptAdapter` combines image/video descriptions with Qwen text adaptation. | The local branch uses configured vision for descriptions and configured text for adaptation. Renderer route selection is pending. |
| Image descriptions, reference sheets, video captions, and shot evaluation | `VlmService` prepares media, assembles prompts, caches captions, and parses responses. Image ingestion schedules descriptions in the background. | `VlmService` uses the configured OpenAI-compatible adapter when a vision entry is present. |
| AutoPrompt and image prompt enhancement | Desktop IPC calls `VlmService`. AutoPrompt can include sampled video frames and reference images. Enhance Prompt sends a text-only request through the same service. | Image-bearing requests use configured vision. Enhance Prompt uses configured text. |
| Director references and shots | `ComfyScriptProjectClient` submits image generation, image edits, and H3 video workflows. | Initial fal reference-generation/edit and shot-generation endpoints pending validation. |
| Editor image and video renders | `ImageRenderService` processes Comfy jobs and rejects former personal-key fal jobs. The Mago Cloud path uses its own linked projects, assets, and jobs. | Direct fal submission with local job tracking and output ingestion. Pending. |
| Video effects and supporting inference | Comfy workflows include Wan Animate/VACE, SAM2 segmentation, Depth Anything, pose estimation, and LTX spatial upscale. | Unavailable in external-provider mode until a suitable endpoint is validated for each workflow. Frame extraction, mask compositing, and encoding can remain local media operations. |

## Availability and startup

- `src/platform/modelProviders.ts`, `providerPreferences.ts`, and `renderTarget.ts` resolve renderer model availability. The cloud route incorporates Mago account state. The existing location flags also affect submission and asset handling. Keep external provider availability separate from those flags.
- `desktop/shared/textModelRoute.ts` intentionally resolves a signed-out legacy Mago text preference to Comfy. External provider selection needs its own explicit availability and failure handling.
- `desktop/main/librarySettings.ts`, `desktop/main/localSetup/`, and `registerComfyHandlers.ts` handle endpoint discovery, setup, and model checks. Director controls and editor render forms also check local readiness. External configuration needs its own readiness state, including when background captions are unavailable.
- `ScriptAgentSignInDialog` offers Mago sign-in and Comfy setup. `useScriptProjectRun` has Mago credit recovery UI, and `estimateCloudRenderCredits` computes estimates using Mago pricing. External jobs need provider-specific availability, cost, and billing errors.
- A profile with a valid external text, vision, or fal entry and no saved account choice opens with local identity. The first-launch screen also offers **Open local editor** without starting ComfyUI setup. Account-free editing, startup background requests, and renderer calls to Mago services still need end-to-end validation.

## Contracts and persisted jobs

The main-process vision boundary takes assembled system and user prompts, ordered encoded images, and generation parameters. It returns text and the model that produced it. The readiness probe still serves the existing desktop status contract. The initial remote adapter adds a request deadline, an image count limit, and errors for HTTP failures, timeouts, and malformed responses. Caller cancellation and richer provider identity are pending. Text generation needs the same request lifecycle and must keep response parsing and project-changing tools in the editor.

The desktop database already has image render and Mago Cloud render job tables. Before adding direct media submission, define a versioned job record with provider and endpoint, immutable credential-free settings, input asset/trim provenance, a remote request ID, terminal state, and output asset provenance. Persist a submission state before sending and persist the remote ID on acceptance. A lost response needs an explicit uncertain state and reconciliation before resubmission. Preserve existing job and asset rows through an additive migration.

The first supported set remains one OpenAI-compatible text model, one vision-capable model, one fal reference image generation/edit workflow, and one fal video shot workflow. Exact model IDs, limits, and pricing are pending endpoint validation.

## Try the initial text and vision adapter on macOS

1. In Keychain Access, create a password item in the login keychain. Set the item name to `MagoStudio.ExternalProvider`, the account to a name such as `openrouter`, and the password to the API key. Grant access if macOS prompts when Mago first reads the item.
2. Open **Local settings → Providers**. For text, vision, or both, enter the API base URL, an exact model ID from the provider's catalog, and the Keychain account name. Use the same account in both entries to share a key.
3. Save each entry, then use **Check connection** to look up its model. OpenRouter also checks the saved key and, for vision, image input support. The check makes no generation request.

You can also edit `external-providers.json` alongside the app-level `settings.json`, typically in `~/Library/Application Support/Mago Studio/` for the packaged app. Use the profile directory of the instance you are running and keep API keys in Keychain.

```json
{
  "text": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "replace-with-text-model-id",
    "keychainAccount": "openrouter"
  },
  "vision": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "replace-with-vision-model-id",
    "keychainAccount": "openrouter"
  }
}
```

Vision covers desktop descriptions, captions, AutoPrompt, and shot evaluation. Text covers desktop script chat, image prompt enhancement, the local branch of video prompt optimization, and casting and shot prompt composition for locally managed Director projects. Cancelling a plan aborts its active external text request. A failed external shot prompt pauses the plan before video submission. Desktop prompt optimization displays the external route and uses local asset IDs for video prompt optimization. Local Director chat and casting can pass the text access check without a Mago sign-in or ComfyUI text model. The first-launch choice can be skipped when valid external-provider settings are already present. Account-free startup has yet to be verified in the packaged app. The existing route serves each omitted capability. Errors from a configured capability are surfaced on that path without switching providers.

The adapter expects an HTTPS API with non-streaming Chat Completions and `max_completion_tokens`. Vision requests send up to four inline PNGs. The vision readiness check lists models and, on OpenRouter, checks image input support and the saved key. These checks make no generation requests. Model-specific output limits and quality still need live validation. [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request) · [OpenRouter vision guide](https://openrouter.ai/blog/tutorials/send-image-to-llm/) · [OpenRouter key check](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)

## Configure the fal Keychain account on macOS

Create a password item in the login keychain named `MagoStudio.ExternalProvider`. Use an account such as `fal` and put the fal API key in the password field. Open **Local settings → Providers → fal.ai**, enter the account name, and save. The equivalent file entry is `"fal": { "keychainAccount": "fal" }` in `external-providers.json`.

**Check Keychain** confirms that Mago can read the saved password item. Live fal authorization and render submission are pending. Removing the provider in Mago removes its account reference from the settings file. The password item can be managed separately in Keychain Access.

## Initial fal rendering endpoints

Reviewed fal's public schemas, examples, and pricing on 2026-11-12. These endpoints are selected for the first implementation. The render controls should let users choose among compatible supported models for each generation, with an optional project default. Each submitted job keeps its own model selection. Account access, actual output, and billed usage still need a live test.

| Director workflow | Endpoint | Initial request and result |
| --- | --- | --- |
| Create a reference sheet | [`fal-ai/nano-banana-2`](https://fal.ai/models/fal-ai/nano-banana-2/api) | Use the existing sheet prompt, a supported aspect ratio, `resolution: "1K"`, `num_images: 1`, and PNG output. Read the file from `images[0].url`. |
| Edit a reference sheet or generate a design variant | [`fal-ai/nano-banana-2/edit`](https://fal.ai/models/fal-ai/nano-banana-2/edit/api) | Use the same output settings with ordered `image_urls`. Preserve Director's master-design-first order when present. Start with one or more images and cap the list at fal's documented 14 references. |
| Render a shot from image references | [`minimax/h3-max/reference-to-video`](https://fal.ai/models/minimax/h3-max/reference-to-video/api) | Use the composed shot prompt and ordered `reference_image_urls`. Start at `768P`, `16:9`, and Director's existing 5–15 second range. Set `prompt_expansion_mode: "disabled"` so the fal call preserves the composed prompt. Download `video.url` and record the returned seed and reference-token count when available. |

Nano Banana 2 already appears in Director's Mago Cloud sheet picker. Its separate text and edit endpoints fit the existing split in sheet rendering. The documented output sizes are presets, so treat the requested aspect ratio and the decoded pixel dimensions as separate fields. Use the current character-sheet layout prompt and measure whether a 1K result provides enough detail. Fal lists $0.08 per 1K image for both endpoints, $0.12 at 2K, and $0.16 at 4K. Leave optional search and high thinking off for the first implementation. [Nano Banana 2 pricing](https://fal.ai/models/fal-ai/nano-banana-2) · [Edit pricing and limits](https://fal.ai/models/fal-ai/nano-banana-2/edit)

H3 Max is the closest fit to the existing shot composer. The composer already has a `minimax_h3_max` engine tag format with `Image N` and `Video N` labels. Use that format and ensure the image list matches the final numbered prompt. The public schema accepts up to 12 references across modalities, documents a separate `image_url` opening frame, and accepts video references from 2 to 15 seconds each with a 15-second combined cap. Start with image-reference shots. Validate opening-frame and video continuity separately before enabling those paths. Keep requested duration and measured output duration because fal documents that output can be about 0.7 seconds longer. Measure frame rate, aspect ratio, and audio tracks on ingestion. [H3 Max API schema](https://fal.ai/models/minimax/h3-max/reference-to-video/api)

At 768p, fal lists $0.08 per requested output second plus $0.02 per 1,000 reference tokens beyond an included 4,096. A five-second shot with one square image reference is estimated at $0.40. A five-second shot with one five-second 16:9 video reference at 24 fps is estimated at about $0.96 under fal's published example. Keep reference surcharges visible when estimating continuity shots. Seedance 2.0 Fast also supports ordered multimodal references, but requires its own `@ImageN` prompt mapping and a different cost model. Leave it outside this first implementation. [H3 Max endpoint pricing](https://fal.ai/models/minimax/h3-max/reference-to-video) · [Seedance 2.0 Fast API](https://fal.ai/models/bytedance/seedance-2.0/fast/reference-to-video)

Fal marks the selected model pages for commercial use. Its terms also describe applicable third-party conditions and input rights. Use a fal API key from the configured macOS Keychain account and confirm that account's endpoint access and billing before the first live generation. Uploads and generated media can remain on fal's CDN, with request history governed separately. Record the retention policy chosen for integration because shorter result availability affects restart recovery. [fal Terms of Service](https://fal.ai/legal/terms-of-service) · [fal API Services terms](https://fal.ai/legal/api-services) · [Data retention and storage](https://fal.ai/docs/documentation/model-apis/media-expiration)

The main-process queue service records the request ID in the local library as soon as fal acknowledges submission. It derives the follow-up URLs from the stored endpoint and request ID on fal’s queue origin. The status endpoint uses the model app path, even when submission used a variant path such as `/edit`. `COMPLETED` can also represent a failure or cancellation, so inspect the result before marking a job successful. A lost submission response leaves the job marked uncertain. Known jobs can be refreshed by request ID after reopening the library. Asset uploads, media downloads, automatic polling, and wiring into Director remain pending. [Queue submission](https://fal.ai/docs/api-reference/inference-api/queue/submit-path) · [Queue status](https://fal.ai/docs/api-reference/inference-api/queue/status) · [Result retrieval and retention](https://fal.ai/docs/api-reference/inference-api/queue/result)

The desktop job service depends on `MediaRenderProvider` for submission, status and output retrieval, and cancellation. Fal's adapter handles its queue URLs, HTTP responses, and credentials. Jobs store the provider ID and endpoint selected at submission, so switching the provider for new renders leaves existing jobs tied to the original adapter. A future Wiro adapter can use its task ID for polling and choose the appropriate cancellation operation for the task state. Model-specific request parameters still need to be mapped for each endpoint. [Wiro Tasks API](https://wiro.ai/docs/tasks)
