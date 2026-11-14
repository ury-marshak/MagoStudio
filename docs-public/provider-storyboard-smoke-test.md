# Packaged storyboard-to-video smoke test

Prepared and run 2026-11-13 with the user's **$1 combined budget approval**. Fresh packaging passed in Herdr terminal `t9` using nvm Node 24.15.0. The tested bundle is `/Users/ury/sources/MagoStudio/release/Mago Studio-darwin-arm64/Mago Studio.app`, built at 01:05:36 IST on November 13; `file` and `lipo` confirm arm64. See the detailed live result in [the integration plan](../PROVIDER_INTEGRATION_PLAN.md#packaged-storyboard-to-video-validation-2026-11-13).

**Historical run, not a reusable authorization.** Future video tests must use **480P**, as requested after this run's 768P video completed. The current source supports a resolution override, and the November 14 package now includes it. The $1 approval below is complete.

## Controls validation completed 2026-11-14 (no paid requests)

- Preserved the earlier bundle/profile under `/tmp/mago-controls-validation-20261114/preserved/`; packaged the updated arm64 app with Node 24.15.0 through Herdr. Both the initial and responsive-fix builds exited 0.
- Used a copied isolated profile/library with nonexistent Keychain account references. Inspected Providers, Assets/draft, Storyboard, individual-shot and batch controls. Fixed toolbar clipping/squeezing; geometry assertions and screenshots cover 1440×868 and 1024×700. The existing-reference edit form still needs a populated-fixture pass.
- Verified independent per-model choices, app persistence after restart, explicit project-default saving, and individual/batch overrides. Historical accepted payloads and the two-job count are unchanged. No inference was submitted. Details, evidence paths and limitations are in the [integration plan](../PROVIDER_INTEGRATION_PLAN.md#packaged-controls-validation-2026-11-14-no-paid-requests).
- Do not submit an inference request during this pass. A subsequent five-second 480P check needs a fresh total budget including required text composition; reuse an existing synthetic reference where practical.
- Verify `resolution: "480P"` in the immutable saved request after an authorized submission. Record requested settings separately from measured media properties. The UI currently composes and submits as one plan: do not promise an intervening inspection pause.

The recipe and results below document the completed November 13 run at 768P. Do not repeat that recipe unchanged.

## Historical scope and approved budget

Run through a fresh arm64 packaged Mago Studio app and its desktop IPC bridge, using the app's configured Keychain credentials. Do not submit through the fal plugin or a standalone API script: those would bypass the integration being checked.

Approved maximum for this completed run: **$1 total**, including fal usage and required external text prompt composition. Verify current endpoint and configured text-model rates before submission; stop if the scoped run cannot reasonably fit within that budget. This is an operator budget, not a server-enforced cost cap. No retries, variants, batch generation, casting, reference-sheet generation, or additional shots are authorized by this scope.

1. One storyboard PNG through `minimax/h3-image/edit`, selected with the per-scene **MiniMax H3 Image (fal)** picker. Use the app-generated blank panel template as the only image input, `num_images: 1`, PNG output, and the app's roughly 1 MP size mapping. No generated character reference is needed.
2. Required external text prompt composition for that one shot using the configured text provider. Preserve the standard storyboard-aware path. Do not use `prompt_rewrite: raw`: `planShotRun.ts` removes `_local_storyboard` in raw mode. Inspect the composed prompt and ordered inputs before video submission. Account for the composer's structured-response retry behavior in the budget; stop on an error rather than manually rerunning the plan.
3. One `minimax/h3-max/reference-to-video` request, selected with the action-level **H3 Max (fal)** picker: five requested seconds, `768P`, `16:9`, `prompt_expansion_mode: disabled`, and the newly generated storyboard as the sole image reference. Disable sequential references. No video/audio reference or opening-frame input.

The previous endpoint evaluation estimated $0.40 base cost for a five-second H3 Max shot, with possible reference-token surcharges; H3 Image is usage based. Those earlier figures are not a fresh account quote. Current public endpoint/schema pages were accessible during preparation, but their rendered pricing was not exposed, and the fal plugin's read-only catalog lookup required reauthentication. Plugin reauthentication is independent of the packaged app's Keychain access.

Sources: [H3 Image edit schema](https://fal.ai/models/minimax/h3-image/edit/api), [H3 Max reference-to-video schema](https://fal.ai/models/minimax/h3-max/reference-to-video/api), and [the repository endpoint evaluation](external-provider-dependencies.md#initial-fal-rendering-endpoints).

## Setup before any paid request

- Build with `/opt/homebrew/bin/bash`, `source ~/.nvm/nvm.sh`, `nvm use 24.15.0`, and `npm run package:desktop -- --arch=arm64`. Confirm process exit 0, a fresh bundle timestamp, and `file`/`lipo -archs` reporting arm64 for `Contents/MacOS/mago-studio`.
- Use a dedicated smoke profile/library and one synthetic Director scene, leaving existing projects and defaults intact. Populate the scene without paid casting. Suggested scene: `[Shot 1] A blue ceramic mug rests on a wooden table in a sunlit pottery studio. The camera slowly pushes in.` No character/environment reference keys are needed. Set five seconds and disable sequential inputs.
- Use the intended configured external text model for composition. Avoid vision/caption/enhancement requests outside this scope. If they cannot be disabled or avoided, pause and revise the budget/scope before generating.
- Open Script, Assets, Scenes, Storyboard, and Timeline while recording main-process output and renderer console/network events. Note the profile, library, bundle path, build time, and test start time. Read only Keychain account references; never put secrets in test artifacts.
- Before clicking Generate, verify the storyboard action picker and shot action picker show the two fal models. Do not explicitly save a project default as part of the test.

## Execution and evidence after approval

- Generate exactly one storyboard. Record its local job ID, remote request ID, stored provider/endpoint, ordered input asset IDs, and ingested PNG asset ID/dimensions. Verify the panel template was input 1 and no ComfyUI setup gate appeared.
- Keep the finished storyboard enabled for that scene and use the normal configured text composition route. The current UI composes and submits as one plan; this historical run did not pause between them. Verify afterward that the stored storyboard asset is the sole video reference and its image number matches the prompt. Separating preparation from submission remains planned.
- Generate exactly one five-second shot within the approved scope. For any new authorized test, explicitly select **480P**. Record local/remote IDs and immutable settings. Poll the existing request; never resubmit after an ambiguous response. Inspect fal history before any later retry.
- Verify the video is ingested, attached to the scene/cut, and plays in Timeline. Export locally and measure decoded width, height, frame rate, video/container duration, codec, and audio tracks; distinguish the five-second request from measured output duration.
- Inspect `<profile>/logs/startup.log`, captured stdout/stderr, renderer console, and recorded network activity for `comfy`, `comfy:script-setup-status`, `ComfyScriptProjectClient`, `8188`, and local inference/setup/model-download attempts. Classify actual calls/errors separately from incidental strings. Absence of log entries alone is not a complete network audit.
- Check billed usage for the two fal request IDs and any external text requests. Add the actual result, spend, output facts, and ComfyUI observations to `PROVIDER_INTEGRATION_PLAN.md` only after the live run. Keep failures and incomplete stages explicit.

## Current result

One storyboard and one five-second H3 Max shot completed and were ingested using the normal storyboard-aware text composition route. A correction to the manually seeded fixture's missing cut entry was required before replaying local completion with the same saved job; no extra generation was submitted. Timeline playback and export then passed. The exported video fully decodes at 1344×768/24 fps with stereo AAC and a 5.216-second container duration.

Fal billable units imply $0.4295465. Adding all OpenRouter daily key usage conservatively bounds the combined test at $0.49498875. Exact ledger/per-test text charges were unavailable. No ComfyUI or 8188 entries were found in captured startup/console logs or the recovery network log; this is not a full generation-time network audit. Request IDs, fixture correction, cost evidence, and verification limits are recorded in the plan.
