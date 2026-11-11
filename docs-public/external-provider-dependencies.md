# External provider dependencies

This inventory reflects Mago Studio 0.19.3. The external-provider column describes the planned path and its current implementation status.

| Workflow | Current dependency | External-provider path |
| --- | --- | --- |
| Director script chat and script writing | `application.ts` calls `TextModelBridge` or Comfy Qwen. `LocalScriptChatService` parses tool responses and persists messages. | OpenAI-compatible text generation with local prompt assembly, parsing, and project writes. Pending. |
| Director casting and shot prompts | `LocalScriptProjectService` delegates whole operations to the bridge or calls Qwen through the local casting and storyboard composers. Shot preparation currently happens in the Comfy render pipeline. | Inject text generation into the local composers and separate shot preparation from video submission. Pending. |
| Character body-plan classification | Reference-sheet completion runs a background Qwen text call in `LocalScriptProjectService`. | Use configured text generation or skip automatic classification when unavailable. Pending. |
| Optimize prompt for video | The renderer selects the legacy text route. The Mago path may mirror references. `LocalI2vPromptAdapter` combines image/video descriptions with Qwen text adaptation. | Use configured vision for descriptions and configured text for adaptation. Pending. |
| Image descriptions, reference sheets, video captions, and shot evaluation | `VlmService` prepares media, assembles prompts, caches captions, and parses responses. Image ingestion schedules descriptions in the background. | `VlmService` now accepts a generator and a separate readiness probe. The current adapter still uses Comfy. OpenAI-compatible vision generation is pending. |
| AutoPrompt and image prompt enhancement | Desktop IPC calls `VlmService`. AutoPrompt can include sampled video frames and reference images. Enhance Prompt sends a text-only request through the same service. | Route image-bearing requests through configured vision and text-only enhancement through configured text. Pending. |
| Director references and shots | `ComfyScriptProjectClient` submits image generation, image edits, and H3 video workflows. | Initial fal reference-generation/edit and shot-generation endpoints pending validation. |
| Editor image and video renders | `ImageRenderService` processes Comfy jobs and rejects former personal-key fal jobs. The Mago Cloud path uses its own linked projects, assets, and jobs. | Direct fal submission with local job tracking and output ingestion. Pending. |
| Video effects and supporting inference | Comfy workflows include Wan Animate/VACE, SAM2 segmentation, Depth Anything, pose estimation, and LTX spatial upscale. | Unavailable in external-provider mode until a suitable endpoint is validated for each workflow. Frame extraction, mask compositing, and encoding can remain local media operations. |

## Availability and startup

- `src/platform/modelProviders.ts`, `providerPreferences.ts`, and `renderTarget.ts` resolve renderer model availability. The cloud route incorporates Mago account state. The existing location flags also affect submission and asset handling. Keep external provider availability separate from those flags.
- `desktop/shared/textModelRoute.ts` intentionally resolves a signed-out legacy Mago text preference to Comfy. External provider selection needs its own explicit availability and failure handling.
- `desktop/main/librarySettings.ts`, `desktop/main/localSetup/`, and `registerComfyHandlers.ts` handle endpoint discovery, setup, and model checks. Director controls and editor render forms also check local readiness. External configuration needs its own readiness state, including when background captions are unavailable.
- `ScriptAgentSignInDialog` offers Mago sign-in and Comfy setup. `useScriptProjectRun` has Mago credit recovery UI, and `estimateCloudRenderCredits` computes estimates using Mago pricing. External jobs need provider-specific availability, cost, and billing errors.
- The desktop has an existing local identity. Account-free editing, startup background requests, and renderer calls to Mago services still need validation with the external mode enabled.

## Contracts and persisted jobs

The main-process vision boundary takes assembled system and user prompts, ordered encoded images, and generation parameters. It returns text and the model that produced it. The readiness probe still serves the existing desktop status contract. A remote adapter needs an explicit deadline, cancellation signal, provider identity, image and token limits, and errors that distinguish unavailable models, authentication, rate limits, malformed responses, and transport failures. Text generation needs the same request lifecycle and must keep response parsing and project-changing tools in the editor.

The desktop database already has image render and Mago Cloud render job tables. Before adding direct media submission, define a versioned job record with provider and endpoint, immutable credential-free settings, input asset/trim provenance, a remote request ID, terminal state, and output asset provenance. Persist a submission state before sending and persist the remote ID on acceptance. A lost response needs an explicit uncertain state and reconciliation before resubmission. Preserve existing job and asset rows through an additive migration.

The first supported set remains one OpenAI-compatible text model, one vision-capable model, one fal reference image generation/edit workflow, and one fal video shot workflow. Exact model IDs, limits, and pricing are pending endpoint validation.
