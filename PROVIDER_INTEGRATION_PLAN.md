# Independent AI providers for Mago Studio

Status: implementation in progress on `codex/provider-integration`.
Date: 2026-11-08
Baseline investigated: Mago Studio 0.19.2. Implementation started on v0.19.3 (`446bdc6`).

## Progress as of 2026-11-14

The model-specific controls are implemented, mock-tested, and packaged for Apple Silicon. No-cost packaged inspection fixed minimum-width toolbar clipping and checked settings persistence/overrides. A separately authorized **480P** smoke test then passed: saved payload, normal cut attachment, playback/export and completed-result persistence after reopening. Calculated fal usage plus OpenRouter key-usage growth was **$0.26152925**, below the fresh $1 budget. That paid scope is complete. **Next implementation: sequential shot frame inputs**, followed by predecessor video inputs. Remaining text/vision cancellation, effects/supporting inference, and full independence/reliability audits remain open.

| Phase | Status | Implemented and remaining |
| --- | --- | --- |
| 1. Dependencies and contracts | In progress | Added the [inference dependency map](docs-public/external-provider-dependencies.md) and extracted the desktop vision generation interface in commit `7c7613c`. The media provider interface and additive external render job migration are in place. Live fal job recovery and model selection passed for the Director workflows below. |
| 2. Settings and startup | In progress | The working tree adds separate text and vision entries in an app-level JSON file, with credentials read by the main process from macOS Keychain. OpenRouter vision readiness checks the model catalog, image input capability, and credential without generating. The first-launch screen can open the local editor without starting the ComfyUI wizard. A profile with valid external text, vision, or fal configuration and no saved account choice opens the local editor directly without checking credentials. Local settings has a Providers tab for editing text and vision metadata and checking the saved configuration without a generation request. The Providers tab also stores a fal Keychain account reference and can check local access to its saved key. API keys are added in macOS Keychain Access. The Apple Silicon development app verified fal Keychain access, live authorization, and account-free startup. |
| 3. Remote text and vision | In progress | The working tree adds an OpenAI-compatible Chat Completions adapter for desktop captions, descriptions, AutoPrompt, shot evaluation, script chat, image prompt enhancement, and the local branch of video prompt optimization. Director casting and shot prompt composition use the configured text provider for their structured passes and abort in-flight requests when the plan is cancelled. Shot preparation is still coupled to the existing video render workflow. The desktop renderer recognizes external text for image and video prompt optimization and bypasses the ComfyUI text setup gate for local Director projects. Cancellation in other callers remains pending. |
| 4. Direct fal rendering | In progress | Selected Nano Banana 2 generation/edit and H3 Max reference-to-video from fal’s public schemas and pricing. The [endpoint evaluation](docs-public/external-provider-dependencies.md#initial-fal-rendering-endpoints) records the initial Director request mapping and live checks. The main-process queue client and additive library migration support durable submission, status and result retrieval, and cancellation. The job service uses a small provider interface for submission, status and output, and cancellation. Fal is the first adapter. Known jobs can be refreshed after reopening the library using the provider saved with each job. Director Assets can select Nano Banana 2, Nano Banana 2.1, or MiniMax H3 Image for reference-sheet generation and editing and save a project default. Director Shots supports H3 Max for image-reference video. The app resumes accepted requests after reopening the library, downloads outputs into local assets, and flags uncertain submissions for review. The live development-app run below verified Nano Banana 2.1 generation and editing and H3 Max image-reference rendering. The packaged run verified MiniMax H3 Image generation and editing. Sequential shot inputs remain pending. |
| 5. Video editing and effects | Pending | Endpoint evaluation and effects integration remain pending. |
| 6. Apple Silicon validation | In progress | The live fal rendering workflow passed in the Apple Silicon development app. Packaged Apple Silicon startup and live OpenRouter text and vision passed with GPT-6.1 Terra at Low reasoning effort. The combined Director workflow also passed in the packaged app. The wider network audit remains pending. |

The provider, prompt, and Director suites passed 1,566 tests, type checking, lint, and desktop TypeScript compilation. The startup slice passed 140 focused tests, including renderer TLS and WebSocket checks. The provider settings slice passed 1,009 tests across settings, prompt, and Director suites. The fal credential slice passed 63 focused tests, including four new tests. The queue and persistence slice passed 486 tests, including eight new tests. The provider interface refactor passed 49 focused tests, including a test with a second mock adapter. The asset transfer slice passed 144 focused tests. The Director reference-sheet slice passed 1,763 tests across the provider, database, Director, and vision suites. The Nano Banana 2.1, H3 Max, and restart recovery slice passed 1,764 focused tests. The MiniMax H3 Image and reference-image model picker changes passed 993 focused tests, type checking, lint, and desktop TypeScript compilation. Automated provider tests used mocked responses. The live fal results are recorded below. See the [manual macOS setup instructions](docs-public/external-provider-dependencies.md#try-the-initial-text-and-vision-adapter-on-macos).

## Resume here

Continue in the current working tree on `codex/provider-integration`. Read this plan and the linked endpoint evaluation before starting the next implementation slice.

1. Asset transfer is implemented. The [job service](desktop/main/providers/externalRenderJobService.ts) uploads ordered local images and ingests finished outputs into the library. Fal uploads use the [single-file storage API](https://github.com/fal-ai/fal-js/blob/main/libs/client/src/storage.ts) with the account's default retention settings.
2. Director Assets offers **Nano Banana 2.1 (fal)**, **MiniMax H3 Image (fal)**, and **Nano Banana 2 (fal)** in the Reference image model picker. A local project can save a default, and each job keeps its selected endpoint. H3 Image uses one roughly 1 MP PNG and usage-based billing. Its generation and edit routes passed mocked and packaged live verification.
3. Director Shots offers **H3 Max (fal)** with image references and configurable 480P/768P/1080P, aspect, seed, and prompt expansion. Built-in defaults remain 768P/16:9. Sequential references must still be suspended. Shot prompts use the configured external text provider when present and the existing raw prompt otherwise. Startup polls accepted requests using saved provider/endpoint/settings and pauses before new generation. Review uncertain requests in fal history and cancel the earlier plan before submitting that item again.
4. The Apple Silicon development-app test passed for reference sheets, image-reference shots, restart recovery, and Timeline export. Packaged startup and live OpenRouter text and vision also passed. The packaged Director run below verified live casting, vision captioning, H3 Image generation and editing, H3 Max, and Timeline export. The wider network audit, sequential inputs, and the first video editing or effects endpoint remain pending.
5. **Local settings → Providers** includes app-wide model choices and per-model generation defaults. A saved Director project choice takes precedence; saving project defaults is explicit. Storyboard uses the same settings and defaults to MiniMax H3 Image when fal is configured. Mocked tests verify the panel template followed by scene references through the fal edit route without a ComfyUI setup probe. The earlier packaged storyboard-to-video check passed with the fixture correction below; the newer generation controls passed the scoped November 14 packaged inspection below, without generating.
6. Action-level model pickers and generation controls cover references, drafts/edits, storyboard scenes, individual shots, and batch actions. Batch uses toolbar choices; individual actions can override them. Previews and submissions share effective model/settings. **Use 480P for future video tests** through the implemented resolution control; this is a test preference, not a forced production default.

7. **Generation settings slice (implemented below): connect model-specific generation settings end to end.** Model selection alone is insufficient: resolution, aspect ratio, quality (where supported), and other relevant model controls must affect the actual generation request. Apply this to reference images, drafts/edits, storyboards, individual video shots, and batch actions. Follow the capability, persistence, and verification requirements in Phase 4 below. Remove the fixed fal video `768P`/`16:9` and image `1K` assumptions where the selected endpoint offers alternatives. Use 480P for future video tests; this is a test preference, not an instruction to force every user's production render to 480P.

8. **Generation settings implementation, 2026-11-13:** the working tree now connects model-specific controls through action requests, IPC, planning, fingerprints, fal payloads, and saved render metadata. Local settings → Providers holds per-model app defaults; project defaults require the explicit save button. References, drafts/edits, storyboards, individual shots, and batch actions have overrides. Main-process validation rejects unsupported settings; changing models keeps each model's independent choices. Nano models expose resolution, aspect, thinking and seed; H3 Image exposes megapixel presets/aspect; H3 Max exposes 480P/768P/1080P, aspect, seed and prompt expansion alongside existing scene duration. The built-in video default remains 768P for compatibility; **select 480P for the next authorized test**. Accepted jobs retain their saved payload during recovery. The current schema limits the image-reference list to nine, so the Director cap now follows that field rather than the combined twelve-file limit. See the [capability and persistence details](docs-public/external-provider-dependencies.md#generation-controls-verified-against-schemas-2026-11-13).
The generation-settings slice passed **1,495 tests across 242 files**, renderer type checking, desktop compilation (`npm run build:desktop`), and lint with the existing 13 warnings. An additional focused run passed 33 settings/storyboard tests after extending settings persistence coverage. No paid requests were submitted and the earlier packaged bundle was preserved.

9. **480P validation completed, 2026-11-14:** the user approved the fresh $1 scope, and one five-second H3 Max shot was submitted through the packaged individual-shot control. The saved request used 480P; output, Timeline/export and reopening checks passed (record below). No additional paid requests are authorized by this completed scope. Proceed with sequential frame inputs using mocks; existing-reference edit controls still need a populated-fixture layout pass.

### Next validation and implementation sequence

1. **Done:** preserve the earlier arm64 bundle/profile, rerun focused checks, and package using Node 24.15.0 through Herdr. Source checkpoint: `b8fd9d9`. No keys are stored in committed files or evidence.
2. **Done within the scope below:** inspect Providers, Assets/draft, Storyboard and Scenes at 1440×868 and the supported minimum 1024×700 renderer viewport. Fix toolbar wrapping and repackage; verify model switching, per-model choices, app restart persistence, explicit project-default saving and individual overrides without generating.
3. **Remaining layout coverage:** exercise the existing-reference edit form with a populated fixture. The reused storyboard fixture has no saved reference entities; draft and storyboard edit-route controls were inspected instead. No live request is needed for this follow-up.
4. **Done:** one separately authorized five-second 480P shot reused the synthetic storyboard; required external text composition, persisted payload, normal cut attachment, playback/export and reopening passed. Cost evidence and network-audit limits are recorded below. No retries or extra generations were submitted.
5. Implement sequential continuity in two slices: previous-shot frames first, then a bounded predecessor video tail. Recheck current endpoint schemas; extend the image-only upload/single-field mapping to typed input roles as needed. Keep prompt numbering, predecessor version/trim provenance, fingerprints, limits, cancellation and accepted-job recovery consistent. Do not simply remove the current fal sequential block.
6. Finish remaining text/vision cancellation and separate shot preparation from submission, then prioritize the full independence/reliability audit before broadening effects. Inventory supporting inference and explicitly gate tasks without a remote replacement.

Pre-commit revalidation for the documentation/implementation checkpoint: **1,669 tests passed across 260 files**, covering providers, Director, database, vision, renderer Director hooks/APIs, Providers settings and shared generation controls. Renderer type checking, desktop compilation, lint (the existing 13 warnings), and `git diff --check` passed. Review found no serious commit blockers or apparent embedded credentials/runtime artifacts. No paid requests were made. The subsequent scoped packaged inspection is recorded below.

The action-level picker slice passed 1,528 focused tests, renderer and desktop type checks, and lint with existing warnings. Fresh arm64 packaging passed on 2026-11-13 in a Herdr terminal pane; see the verified packaging handoff below. The user approved **$1 total** for the [packaged storyboard smoke test](docs-public/provider-storyboard-smoke-test.md), which has now run. Fal billable units imply $0.4295465; adding the OpenRouter key's entire daily usage gives a conservative combined ceiling of $0.49498875. No additional generation was submitted after completion.

### Packaged 480P video smoke test, 2026-11-14

- **Authorization and scope:** the user approved proceeding after the fresh **$1 total** proposal for one five-second 480P shot including required text composition. Used the `d6dee8a` arm64 package and a separate copied profile/library at `/tmp/mago-480p-smoke-20261114/profile`. Restored only the configured text/fal Keychain account references; no keys were copied to files or renderer. No new storyboard/reference, casting, vision, enhancement, sequential input, or extra video generation was requested.
- **Current rates checked before submission:** fal's pricing API and endpoint page showed $0.05/requested second at 480P, with 4,096 included reference tokens and $0.02/1,000 excess tokens. OpenRouter's catalog listed GPT-6.1 Terra at $1/M input and $5/M output tokens. The one-reference video base estimate was $0.25, leaving ample budget for the bounded normal prompt-composition/repair path.
- **UI submission:** Playwright connected over CDP to the actual packaged renderer and clicked `shot-rerender-1` exactly once. The action showed five seconds, H3 Max, **480P**, 16:9, seed **42**, and disabled prompt expansion. The existing storyboard asset `dfa1e7681fc39ec588b1e669bec425d984fd4743792203b3f42644f100493249` was the only reference. Normal composition used `openai/gpt-6.1-terra` at Low through the external route with `fallback: false`; its numbered reference and `Image 1` prompt match the uploaded storyboard.
- **Persisted request:** plan `737e3f37-dbf6-46f3-a7ad-656edcd5cd0d`; local job `e70da92e-70db-4984-afdc-6fb4b9345268`; fal request `01a1da36-f27e-78b0-bd58-2564bda8c5ef`, endpoint `minimax/h3-max/reference-to-video`. Saved payload is `duration: 5`, `resolution: "480P"`, `aspect_ratio: "16:9"`, `seed: 42`, `prompt_expansion_mode: "disabled"`, with one `reference_image_urls` entry. Fal returned seed 42 and 1,824 reference tokens, below the included allowance.
- **Completion:** all six plan steps completed; job reached `INGESTED`. The app attached and selected new cut version 2 normally, without fixture correction or database edits after submission. Video asset: `4f8f9177fab3aec723f4780e76fc81dd3a1b0f26f89e5e5d4a3ae77eb77bf5e6`. The two historical jobs/versions remain present; total external-job count increased from two to exactly three.
- **Requested versus measured:** the app's estimated provider size was 848×480; actual decoded output is **832×480**, H.264, **24 fps**, 5.166667 seconds of video, stereo AAC, and a 5.184-second provider container. The preset request and measured dimensions/duration are recorded separately. A sampled frame showed the blue mug on the studio table rather than the storyboard's line art.
- **Playback/export:** Timeline played the new asset, advanced past 0.5 seconds while unpaused, showed **Pause the cut**, and paused at the end. **Download all** produced a fully decodable **1,805,608-byte MP4** with the same 832×480/24 fps video and stereo AAC; exported container duration is **5.216 seconds**. Export asset `3f5a9fe3256f3c4593b42e1b2295262665a17031e32c3eda98e52180dcab7872`. CDP saved the normal blob download to its suggested filename; Playwright's subsequent `saveAs` expected its own nonexistent temporary file. Copied the actual completed download to `480p-smoke-export.mp4`; this was an automation-path issue, not an export failure, and no repeat export/generation was needed.
- **Cost evidence:** an existing-result GET returned `x-fal-billable-units: 5.0`; at the freshly checked $0.05 base unit this implies **$0.25**. OpenRouter key total usage grew from $0.06544225 to $0.0769715, a **$0.01152925** delta matching its daily usage. Combined calculated amount: **$0.26152925**. This is not a fal ledger receipt or an adapter-retained per-request text receipt; shared-key concurrent usage would be included in the key-wide delta. No further generation was submitted.
- **Reopening/log limits:** deliberately stopped and reopened the app after completion. It displayed the same 480P asset, with the same `INGESTED` request and three-job count. No ComfyUI/8188 matches appeared in captured console, startup log or Chromium net log. No setup/model-download prompt appeared. Chromium recorded no HTTP URL entries for the main-process provider calls; this does **not** establish a complete network/background-inference audit.
- **Evidence and handoff:** `/tmp/mago-480p-smoke-20261114/` contains `authorized-scope.json`, read-only pricing/usage responses, before/after databases, `evidence.json`, saved request/result headers, media probes, decoded frame, playback screenshots, `restart-check.json`, logs, and the exported MP4. The reopened app remains on Timeline in Herdr terminal `t1c`. No native desktop access was needed. The $1 scope is complete; sequential implementation can proceed with mocks, and another paid generation needs fresh approval.

### Packaged controls validation, 2026-11-14 (no paid requests)

- Committed the provider/Director implementation and updated documentation in `b8fd9d9` (69 files). The worktree was clean before starting validation.
- Backed up the earlier bundle and smoke profile under `/tmp/mago-controls-validation-20261114/preserved/`. The new isolated profile/library is `/tmp/mago-controls-validation-20261114/profile`; copied media paths were rebased to that profile. Provider entries use the nonexistent Keychain account `mago-controls-validation-no-credential`, not the real accounts. No Generate action or connection check was invoked.
- Both `npm run package:desktop -- --arch=arm64` builds exited 0 through Herdr using nvm Node 24.15.0: initial controls (`t16`) and the responsive-layout fix (`t18`). The rebuilt bundle is `release/Mago Studio-darwin-arm64/Mago Studio.app`; final `app.asar` timestamp is **2026-11-14 14:55:33 IST**. `file`/`lipo` confirmed arm64 for the initial build.
- Providers showed the supported values and saved independent defaults: Nano 2.1 at 2K, Nano 2 at 0.5K, H3 Image at approximately 2 MP, and H3 Max at 480P/16:9 with seed 42. These persisted through app restart. Draft model switching preserved its 4 MP H3 action override while Nano retained 2K.
- Explicitly saving a 768P project video default overrode the 480P app default after restart; an individual 480P action override did not change the batch 768P value and was not persisted as a project default on reload. Storyboard batch 2 MP and individual 4 MP remained independent. The isolated project was subsequently explicitly reset to 480P for future tests; production defaults and the earlier profile were not changed.
- Inspection found Assets clipping its batch action and Scenes squeezing controls/count labels at minimum width. Added wrapping/nonshrinking toolbar items and bounded the shared controls, rebuilt, and rechecked. Browser geometry assertions passed at **1440×868 and 1024×700** across Assets (including a draft), Storyboard and Scenes; screenshots were inspected. Providers also fit at the smaller viewport. The existing-reference edit form was not exercised because this fixture has no reference entities.
- Follow-up verification passed **1,090 tests across 232 files**, renderer type checking, lint with the existing 13 warnings, and packaging (including renderer/desktop compilation). The two accepted historical jobs retain identical IDs, remote IDs, payloads and statuses; the external-job count remains two. No new inference was submitted.
- Evidence: `/tmp/mago-controls-validation-20261114/` contains build logs/exit records, before/after screenshots, `layout-assertions.cjs`, `layout-assertions.json`, and `validation-summary.json`. That no-credential instance was later stopped before the separately authorized 480P run. The no-credential profile is not suitable for a paid test until deliberately configured with the authorized account references.
- Limits: this is UI/settings validation, not a live 480P payload/output check, a repeated export/recovery test, or a full main-process/background network audit. A new paid check still requires fresh approval.

### Packaging handoff, 2026-11-13

- Preserved the existing uncommitted work on `codex/provider-integration`. `.nvmrc` remains `24.15.0`. Installed that version with the machine's existing nvm; `nvm use 24.15.0` reports Node v24.15.0 and npm v11.12.1. Use `/opt/homebrew/bin/bash` and source `~/.nvm/nvm.sh` before building.
- Ran `npm run package:desktop -- --arch=arm64`. The sandbox reproduced the PostCSS/Turbopack failure. Requested and received tool approval for an outside-sandbox run using nvm; that run and one retry also exited 1 at `package:desktop → build → build:web → next build`. The failing input is `src/app/globals.css`; the reported endpoint is `/_not-found/page`. The cause chain ends with `creating new process → binding to a port → Operation not permitted (os error 1)`. Neither desktop TypeScript compilation nor Electron Forge was reached.
- A separate approved outside-sandbox Node v24.15.0 diagnostic successfully bound `127.0.0.1:0` (assigned port 53302) and `127.0.0.1:49371`. Therefore a blanket host loopback prohibition does not explain the remaining build failure; Turbopack still reports a bind denial in its worker path. Do not claim the outside-sandbox retry fixed it. Do not pass `--webpack` alone: the current config enables a Turbopack-only compiler option.
- Build logs: `/tmp/magostudio-package-arm64-20261113.log` (sandbox), `/tmp/magostudio-package-arm64-20261113-unsandboxed.log` (approved nvm run), and `/tmp/magostudio-package-arm64-20261113-retry.log` (approved retry). These are temporary diagnostics, not committed artifacts.
- The user directed a rerun through Herdr. Read `~/.config/herdr-app/AGENTS.md`, created pane `p510316856be7e3cfb25faa50477c76b0` / terminal `t9` with `/opt/homebrew/bin/bash --login`, and ran the same packaging command after sourcing nvm and selecting 24.15.0. **Exit 0**: Next.js/Turbopack, renderer TypeScript, desktop compilation, and Electron Forge arm64 packaging all passed. The pane remains open with the output. Log: `/tmp/magostudio-package-arm64-herdr-20261113.log`; exit record: `/tmp/magostudio-package-arm64-herdr-20261113.exit`.
- Fresh bundle: `/Users/ury/sources/MagoStudio/release/Mago Studio-darwin-arm64/Mago Studio.app`. Bundle and `Contents/MacOS/mago-studio` timestamps: **2026-11-13 01:05:36 IST**; packaged `Contents/Resources/app.asar`: **01:05:38 IST**. `file` reports `Mach-O 64-bit executable arm64`; `lipo -archs` reports only `arm64`. This replaces the November 12 bundle. Packaging is no longer blocked; no source/config workaround was needed.
- The user subsequently approved the $1 combined smoke-test budget. The live result is recorded below. Preserve the fresh bundle and smoke profile for inspection; use 480P for future video tests.

## Packaged storyboard-to-video validation, 2026-11-13

Used the fresh arm64 bundle above, a dedicated profile/library at `/tmp/mago-storyboard-smoke-20261113`, and a seeded synthetic Director scene showing a blue mug on a wooden table in a pottery studio. The profile contained fal and external text Keychain account references, with no vision entry. No casting, captioning, image enhancement, reference-sheet generation, sequential references, or additional video generations were requested. The app opened the local editor without sign-in or a ComfyUI setup gate. Per-scene storyboard and shot pickers showed MiniMax H3 Image (fal) and H3 Max (fal); no project default was saved.

- **Storyboard:** one `minimax/h3-image/edit` request, `01a1d206-d323-7653-ade8-b1727a635ea4` (local job `315de4ba-b1d2-4522-92d6-34cfe4af7443`). The app-generated blank panel template was the only input. One 1360×768 PNG was ingested as asset `dfa1e7681fc39ec588b1e669bec425d984fd4743792203b3f42644f100493249`. Visual inspection showed the numbered panel, mug, pottery-studio outlines, and movement arrows.
- **Prompt and video:** the normal storyboard-aware composer used `openai/gpt-6.1-terra` at Low through the external route, with `fallback: false`. Its persisted result names the storyboard as the sole numbered image. One `minimax/h3-max/reference-to-video` request, `01a1d20a-7b47-7303-b91b-6897efb06f69`, used that exact storyboard asset as its only reference, requested five seconds at `768P`/`16:9`, and set `prompt_expansion_mode: disabled`. The stored prompt identifies `Image 1` as composition guidance and says to stage the shot as panel 1. Video seed: 1089904688; reference tokens: 1,824, within the included 4,096. Request and prompt mapping were verified from persistence after submission; the UI executes composition and submission as one plan, so this run did not pause between them.
- **Fixture correction and recovery:** the manually seeded fixture initially omitted the empty cut entry normally written during casting. The render plan completed and ingested its video, but could not attach it to that absent entry. Corrected only the isolated fixture to match `emptyCutShotEntry`, backed up its database, marked only `poll_video_render` unfinished, and relaunched. The packaged app recovered the same `INGESTED` job, attached exactly one version, and completed the plan. No new text or fal generation was needed. This was a fixture error, not an unassisted first-pass Timeline attachment result.
- **Playback/export:** Timeline showed the mug clip, changed Play to Pause during playback, and returned to Play afterward. **Download all** produced a fully decodable 4,054,393-byte MP4 at `/tmp/mago-storyboard-smoke-20261113/storyboard-smoke-export.mp4`: H.264, 1344×768, 24 fps, 5.166667 seconds of video, stereo AAC, and 5.216 seconds container duration. Ingested asset: `d42296c309efbb861711e1858c4d8cca660590f146299261ab5d7bf7eb28a737`. The original provider file has a 5.184-second container duration.
- **Cost evidence:** existing-result GETs returned `x-fal-billable-units: 29.5465` for the image and `8.0` for the video. The pricing API returned $0.001/unit and $0.05/second base units, implying **$0.0295465 + $0.40 = $0.4295465** before any discount. Image token usage independently matches that amount. These are billable-unit calculations, not billing-ledger receipts: fal usage/billing-event queries returned HTTP 403 with this key. OpenRouter's read-only key endpoint reported **$0.06544225 for the entire day's key usage**, with zero BYOK usage. Even charging all of that daily total to this test gives **$0.49498875**, below the approved $1. Exact per-test text cost was not retained by the adapter.
- **ComfyUI log review:** no `comfy`, `ComfyScriptProjectClient`, or `8188` matches in captured `console.log`, `logs/startup.log`, or the recovery-session Chromium net log. No setup/model-download gate appeared while visiting Script, Assets, Storyboard, Scenes, and Timeline. Logs contain DNS warnings and a renderer/network-service exit when the first test process was deliberately stopped for fixture correction. The network log began on recovery, not before the paid requests, and does not establish a full main-process network audit.
- **Future tests:** the user requested 480P after the sole video had already completed at 768P. No replacement generation was made. The later generation-settings implementation now supports a 480P action override, but this earlier packaged bundle does not contain those controls. Package and validate them before the next separately authorized live request.

Temporary evidence is in `/tmp/mago-storyboard-smoke-20261113/evidence.json`, with endpoint responses/headers, media probes, logs, and the fixture backup alongside it. The recovered app remains open under Herdr Core terminal `t12` for inspection. Paid scope is complete; another generation needs its own authorized scope/budget.

Use mocks for routine verification. The [endpoint evaluation](docs-public/external-provider-dependencies.md#initial-fal-rendering-endpoints) records the initial fal endpoints and validation gaps. Wiro is an example of a future adapter.

## Live fal validation on Apple Silicon, 2026-11-12

The Electron development app opened the local editor without Mago sign-in or ComfyUI setup. Its Providers tab read the fal Keychain entry. The test used a new Director project with a seeded synthetic character and shot, so it exercised rendering without needing a text or vision provider.

- Nano Banana 2.1 generated one 1K reference sheet and edited it using the original as the only reference. Both 1376×768 PNGs were ingested and displayed in Director. Fal's usage dashboard showed $0.04 for each endpoint, rounded to cents.
- H3 Max accepted one five-second request at 768P with a 16:9 preset and the edited sheet as its only reference. The app was terminated after the request ID was saved in the `SUBMITTED` state. On relaunch it ingested that same request and attached the shot to the cut. Fal showed one request for the endpoint and $0.40 in usage.
- The recovered video played in Timeline. **Download all** produced a fully decodable 1344×768 MP4 at 24 fps with stereo AAC and a 5.22-second container duration. Mago measured 5.167 seconds of video. The Timeline preview letterboxed the landscape clip in the default portrait canvas.

## Packaged Apple Silicon validation, 2026-11-12

The arm64 app opened the local editor from a fresh profile with provider settings and no saved account choice. Both OpenRouter connection checks and the fal Keychain check passed. With `openai/gpt-6.1-terra` and Low reasoning effort saved for both capabilities, the packaged app enhanced a text prompt and captioned an imported synthetic red PNG. The packaged run used the renderer’s desktop IPC bridge. The earlier fal rendering and Timeline export ran in the development app.

Electron Forge exited during extraction without writing a bundle under Node 26. Running Forge with the repository’s required Node 24.15.0 produced the arm64 app.

## Combined Director run in the packaged app, 2026-11-12

- GPT-6.1 Terra at Low cast a synthetic pottery-studio script into one shot, captioned the generated reference, and composed the video prompt.
- MiniMax H3 Image generated and edited one character reference. Both 1376×768 PNGs were ingested. The edited reference was the sole image input to one five-second H3 Max shot with sequential inputs disabled.
- The H3 Max result played in Timeline. **Download all** produced a fully decodable 1344×768 H.264 MP4 at 24 fps with stereo AAC and a 5.216-second container duration. The renderer retrieved the full export with HTTP 200.
- The initial packaged run reproduced one `comfy:script-setup-status` error on entering Scenes. The video view was loading model status for the separate Storyboard tab. After scoping the storyboard checks to that tab, the rebuilt app reopened the same project and visited Script, Assets, Scenes, and Timeline. The console and startup logs contained no ComfyUI or port 8188 entries during that pass. At the time of this run, the Storyboard tab still used local model checks. The fal Storyboard route was added afterward and passed the later November 13 packaged check recorded above; the newer generation controls subsequently passed the November 14 UI/settings inspection and separately authorized live 480P check above.

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
- Connect generation controls to the selected model's actual capabilities. Offer resolution/output size, aspect ratio, and quality where supported, plus relevant duration, frame-rate, audio, seed, output-format, or prompt-expansion controls where the endpoint exposes them. Verify each endpoint's schema and constraints before implementation; show supported values and combinations, and make fixed constraints visible. Do not show an effective-looking control whose value is ignored by the adapter.
- Carry the effective settings from every Generate action through renderer contracts, desktop IPC, planning, prompt composition, and the provider payload. Cover reference generation, drafts/edits, storyboards, individual shots, and batch actions. Use the same settings for previews, dry runs, availability checks, cost estimates, and submission. Changing models must revalidate settings and surface incompatible choices before a paid request, rather than silently replacing an explicit selection.
- Resolve generation settings in the same order as model choices: current action override, explicitly saved project default, app default, then model-specific built-in default. Save project defaults only on explicit request. Preserve compatible existing project choices when adding these controls.
- Persist the effective provider settings with each job and render version, include output-affecting choices in render fingerprints, and reuse the immutable saved settings for recovery/retry. A later control or default change must not alter an accepted job. Record requested resolution/aspect/quality separately from measured output dimensions, duration, and frame rate; keep project canvas/export settings distinct from provider generation settings.
- Verify with mocked integration tests that changing each supported control changes the submitted endpoint payload and persisted settings; cover invalid combinations, model switches, precedence, batch versus individual overrides, fingerprints, and recovery. The next explicitly budgeted live video check should select 480P through these controls and confirm that the saved request actually sends 480P.

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
