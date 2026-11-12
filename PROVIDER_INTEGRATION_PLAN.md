# Independent AI providers for Mago Studio

Status: implementation in progress on `codex/provider-integration`.
Date: 2026-11-08
Baseline investigated: Mago Studio 0.19.2. Implementation started on v0.19.3 (`446bdc6`).

## Progress as of 2026-11-12

| Phase | Status | Implemented and remaining |
| --- | --- | --- |
| 1. Dependencies and contracts | In progress | Added the [inference dependency map](docs-public/external-provider-dependencies.md) and extracted the desktop vision generation interface in commit `7c7613c`. The media provider interface and additive external render job migration are in place. End-to-end job recovery and live model selection remain pending. |
| 2. Settings and startup | In progress | The working tree adds separate text and vision entries in an app-level JSON file, with credentials read by the main process from macOS Keychain. OpenRouter vision readiness checks the model catalog, image input capability, and credential without generating. The first-launch screen can open the local editor without starting the ComfyUI wizard. A profile with valid external text, vision, or fal configuration and no saved account choice opens the local editor directly without checking credentials. Local settings has a Providers tab for editing text and vision metadata and checking the saved configuration without a generation request. The Providers tab also stores a fal Keychain account reference and can check local access to its saved key. API keys are added in macOS Keychain Access. Live fal authorization and end-to-end startup validation on Mac remain pending. |
| 3. Remote text and vision | In progress | The working tree adds an OpenAI-compatible Chat Completions adapter for desktop captions, descriptions, AutoPrompt, shot evaluation, script chat, image prompt enhancement, and the local branch of video prompt optimization. Director casting and shot prompt composition use the configured text provider for their structured passes and abort in-flight requests when the plan is cancelled. Shot preparation is still coupled to the existing video render workflow. The desktop renderer recognizes external text for image and video prompt optimization and bypasses the ComfyUI text setup gate for local Director projects. Cancellation in other callers remains pending. |
| 4. Direct fal rendering | In progress | Selected Nano Banana 2 generation/edit and H3 Max reference-to-video from fal’s public schemas and pricing. The [endpoint evaluation](docs-public/external-provider-dependencies.md#initial-fal-rendering-endpoints) records the initial Director request mapping and live checks. The main-process queue client and additive library migration support durable submission, status and result retrieval, and cancellation. The job service uses a small provider interface for submission, status and output, and cancellation. Fal is the first adapter. Known jobs can be refreshed after reopening the library using the provider saved with each job. Asset uploads, Director wiring, local ingestion, and automatic restart polling remain pending. |
| 5. Video editing and effects | Pending | Endpoint evaluation and effects integration remain pending. |
| 6. Apple Silicon validation | Pending | The full account-free workflow and cloud-only inference still need end-to-end verification. |

The provider, prompt, and Director suites passed 1,566 tests, type checking, lint, and desktop TypeScript compilation. The startup slice passed 140 focused tests, including renderer TLS and WebSocket checks. The provider settings slice passed 1,009 tests across settings, prompt, and Director suites. The fal credential slice passed 63 focused tests, including four new tests. The queue and persistence slice passed 486 tests, including eight new tests. The provider interface refactor passed 49 focused tests, including a test with a second mock adapter. Provider tests used mocked responses. Live Keychain access, model-specific behavior, and paid generations remain unverified. See the [manual macOS setup instructions](docs-public/external-provider-dependencies.md#try-the-initial-text-and-vision-adapter-on-macos).

## Resume here

Continue from the latest commit on `codex/provider-integration`. Read this plan and the linked endpoint evaluation before starting the next implementation slice.

1. Implement asset transfer. Extend [the media provider interface](desktop/main/providers/mediaRenderProvider.ts) only as needed for provider-specific upload. Keep fal upload and authentication details in [the fal adapter](desktop/main/providers/falRenderProvider.ts). Download finished outputs from the [job service](desktop/main/providers/externalRenderJobService.ts) into the local library and record the resulting asset IDs. Reuse existing media storage and handle interrupted downloads without resubmitting generation.
2. Wire Director reference sheets first. Use the existing generation and edit flow and let users choose a compatible provider/model per generation. Keep an optional project default and persist the actual selection with the job.
3. Add shot rendering and automatic restart polling. Resume known jobs through their saved provider and endpoint. Surface uncertain submissions for review before any new submission.

Use mocks for routine verification. The user is waiting to add credentials until a live test is needed. The [endpoint evaluation](docs-public/external-provider-dependencies.md#initial-fal-rendering-endpoints) records the initial fal endpoints and validation gaps. Wiro is an example of a future adapter.

## Goal

Use Mago as a local desktop editor with our own AI accounts:

- fal.ai for image generation, video generation, and video editing/effects.
- Configurable remote text and vision models through providers such as OpenRouter, initially through OpenAI-compatible APIs.
- Local projects, database, timeline, media preparation, output storage, and export.
- No required Mago account, Mago Cloud subscription, ComfyUI installation, or local GPU.

All model inference in the target workflow runs on external cloud providers. Local inference, local model servers, model downloads, and GPU/backend compatibility work are out of scope for this implementation. Apple Silicon is a primary target for the desktop editor and media processing.

## Approach

Preserve Mago's editor and production workflows. Replace the inference layer behind provider interfaces, reusing the existing local prompts, structured-response validation, retries, frame sampling, and project updates.

Replace model execution in the target workflow with our configured cloud providers. Existing Mago Cloud/ComfyUI code may remain during migration, but preserving those execution routes is not a delivery requirement. Preserve project data and historical render outputs. Select providers explicitly; an error must never silently send a request to another provider or incur a second charge. Do not fall back to local inference.

Treat text, vision, image generation, and video processing as independently configurable capabilities. The same provider may serve several capabilities, but configuring one must not require configuring all of them.

For image and video generation, offer the compatible supported models at submission time in every project. A project may remember a default, and users can override it for any generation. Persist the selected provider, endpoint, and settings with each job so retries and restart recovery use the original selection. Initial endpoint choices define the first supported set. Adding a model requires a capability and request mapping for the applicable workflows.

## What the current code gives us

- `src/platform/modelProviders.ts` and `renderTarget.ts`: model/provider selection and availability. Currently limited to `local-comfy` and `mago-cloud`; execution location and Mago sign-in are coupled in places.
- `desktop/main/application.ts`: service composition and existing injected callbacks.
- `desktop/shared/textModelRoute.ts` and `textModelRequest.ts`: existing text routing and request contracts.
- `desktop/main/scriptProjects/`: local script chat, casting, storyboard, and shot-prompt workflows. Some ComfyUI clients are instantiated directly inside services.
- `desktop/main/vlm/vlmService.ts`: vision prompts, caption caching, media descriptions, shot evaluation, and frame preparation. Its generation path directly constructs a ComfyUI client.
- `desktop/main/imageRenders/`: local job processing and asset creation. Current submission and processing reject former personal-key fal jobs.
- `src/domains/cloud/` and `desktop/main/cloud/`: Mago-specific mirroring, submission, polling, and output ingestion. Direct fal requests must not depend on creating Mago cloud projects or assets.

The existing cloud text callback is an operation-level interface: casting and video-prompt requests may delegate prompt assembly to Mago's server. It is not a generic model API transport. Prefer adapting below local prompt assembly so our provider can reuse the complete local workflow.

## Phase 1 — Inventory dependencies and define contracts

1. Trace every inference call and prerequisite, including script chat, casting, shot prompts, prompt adaptation/enhancement, reference sheets, captions, shot evaluation, image renders, video renders, and supporting model tasks such as segmentation/mask generation or depth/pose estimation. Assign each model task a cloud replacement or mark it unavailable until integrated; none may implicitly require local inference.
2. Identify Mago account/credit checks, ComfyUI setup checks, model discovery, and background tasks that currently block these paths.
3. Define provider-neutral contracts for text/vision requests and media jobs. Include cancellation, timeouts, errors, provider/model identity, and capability information.
4. Separate provider availability from Mago sign-in and separate remote execution from Mago Cloud. Audit existing `local`/`cloud` flags before changing their meaning.
5. Define persisted job metadata: provider, endpoint/model, request ID, settings snapshot, input/output provenance, and terminal state. Preserve existing projects and historical jobs through compatible migrations.

Deliverable: dependency map, interfaces, and a scoped list of initial supported models.

## Phase 2 — Provider settings and account-free startup

- Add settings for fal credentials and separate text/vision base URLs, model IDs, and credentials, including an OpenRouter configuration. Allow text and vision to share a configuration.
- Keep credentials in the Electron main process using an OS-backed secret store; do not expose them to renderer code, logs, project exports, or plain-text project settings.
- Route provider requests through main-process services and narrow IPC contracts.
- Add connection/capability checks that do not trigger paid generations by default.
- Let users configure external providers without signing in to Mago or completing ComfyUI setup. Describe this as an external-provider mode rather than promising offline operation.
- Remove local GPU checks, local model installation prompts, and ComfyUI readiness checks from the target workflow. Editing remains usable without a network connection; new inference requires the configured cloud service.
- Ensure unavailable optional providers do not prevent opening, editing, importing, or exporting a project.

Deliverable: usable provider configuration and startup on Mac without Mago login or ComfyUI.

## Phase 3 — Remote text and vision

- Extract interfaces around local text generation methods and the VLM generation call; inject implementations instead of constructing ComfyUI clients inside production workflows.
- Implement an OpenAI-compatible text/vision adapter with OpenRouter as an initial integration target, starting with an explicitly tested API shape rather than assuming every compatible endpoint supports the same features. Verify the selected models' vision and structured-response capabilities.
- Reuse local system prompts, prompt templates, tool declarations, schemas, response parsing, and repair attempts. Keep project-changing tool execution inside Mago.
- Support image inputs for vision and preserve existing video frame extraction. Make image/token limits and structured-output support explicit capabilities.
- Cover script chat, casting, shot prompts, prompt optimization/adaptation, media/reference descriptions, and shot evaluation.
- Retain caption caching and report provider failures clearly. Do not silently substitute another model for an unavailable one.

Deliverable: a script can be turned into a local project with remote text and vision calls, with no ComfyUI dependency in those paths.

## Phase 4 — Direct fal image and video generation

Start with one image model that covers reference generation/editing and one video model that covers the selected initial shot workflow. Verify their live schemas, licensing/access conditions, limits, and rates before choosing endpoints.

- Implement authenticated fal requests, input uploads, queue submission, polling, cancellation, and result download.
- Persist remote request IDs promptly and reconcile jobs after app restart. Avoid blindly retrying an uncertain submission and creating duplicate paid jobs.
- Reuse existing local media preparation and asset/track/clip bookkeeping where possible. Refactor reusable output ingestion out of Mago-specific cloud code when useful.
- Normalize output dimensions, frame rate, duration, audio, and provenance. Handle expired output URLs and interrupted downloads.
- Make results usable by Director, reference-sheet generation, and the ordinary editor timeline.
- Show model-specific cost estimates when reliable, identify their source, and distinguish estimated cost from confirmed usage.

Deliverable: generate reference images and a video shot directly through our fal account, store outputs locally, and resume tracking after restart.

## Phase 5 — Video editing and effects coverage

Build a capability matrix from current fal endpoints for:

| Editing task | Required inputs/behavior to check |
| --- | --- |
| Scene transformation and restyling | Source video, reference images, motion/timing preservation |
| Character/performance transfer | Character references, motion source, identity and lip-sync behavior |
| Masked editing/inpainting | Mask support, mask alignment, preservation outside the edit |
| Subject removal/clean plates | Removal controls and temporal background reconstruction |
| Upscaling/restoration | Duration limits, detail changes, audio and frame-rate handling |
| SDR-to-HDR | Genuine HDR output, metadata, color management, and export compatibility |

Integrate tasks incrementally. Expose only settings an endpoint actually supports. Do not promise identical Mago engine behavior or frame correspondence; measure timing and preserve or explicitly communicate any mismatch. Chaining multiple endpoints is a separate workflow with its own costs and failure recovery.

Deliverable: documented coverage with tested alternatives, known differences, and unavailable capabilities clearly represented in the UI.

## Phase 6 — Mac validation with cloud-only inference

- Validate the editor and external-provider workflows on Apple Silicon without CUDA, ComfyUI, or model downloads.
- Verify media preparation, output ingestion, playback, audio, and export on macOS.
- Verify that foreground and background model tasks use the configured cloud providers, including automatic captions and supporting analysis/mask tasks.
- Verify that no local inference process starts and that no model weights, ComfyUI nodes, CUDA, Metal/MLX inference packages, or local model servers are needed.
- Keep ordinary local processing such as ffmpeg frame extraction, resizing, encoding, and compositing. These are media operations, not model inference.

Deliverable: an Apple Silicon validation record showing the complete supported workflow runs with cloud-only inference.

## Verification and rollout

- Use focused automated tests for provider routing, input mapping, response validation, job state transitions, persistence, migrations, and output ingestion. Mock remote APIs for routine tests.
- Run repository type checks, lint, relevant tests, and desktop/web builds as appropriate to each implementation phase.
- Run a small, explicitly authorized set of paid integration generations with a stated budget; record the exact model/settings and actual results.
- Exercise cancellation, lost connectivity, malformed responses, rate limits, insufficient credit, restart recovery, and partial failure during a multi-step Director run.
- Verify independently of providers that the target workflow makes no requests to Mago services, does not require a ComfyUI endpoint, and never falls back to local inference. Audit authentication, telemetry, sync, and background requests before claiming full independence.
- Release in stages: provider settings → text/vision → one image/video workflow → additional effects. Document the supported subset at each stage.

## Completion criteria

On an Apple Silicon Mac, a user can launch without a Mago account, ComfyUI, or installed model weights, configure their own cloud providers, create a script project, generate references and video shots, review/edit the results, and export a finished sequence. All model inference runs remotely, including background and supporting model tasks. Requests go only to deliberately configured services; projects and outputs stay locally managed, while required inference inputs are sent to those services. Jobs recover predictably after restart, and the UI accurately describes model capabilities and costs.

## Decisions to make during implementation

- First fal video-editing task to support. The initial image and shot-generation endpoints are recorded in the [endpoint evaluation](docs-public/external-provider-dependencies.md#initial-fal-rendering-endpoints).
- Initial OpenRouter text/vision models and any additional OpenAI-compatible providers/API shapes to support.
- Model-specific input limits and quality targets for the first release.
- Cloud endpoints for supporting model tasks, including segmentation/mask generation and any required depth/pose analysis.
- Whether to hide or remove legacy Mago Cloud/ComfyUI UI paths during migration; maintaining local inference support is out of scope.

Do not block interface design and dependency cleanup on these choices. Confirm live endpoint behavior before implementing model-specific mappings.
