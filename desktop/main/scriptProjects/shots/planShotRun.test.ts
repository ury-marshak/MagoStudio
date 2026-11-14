import { describe, expect, it } from "vitest";

import {
  FAL_SHOT_PROVIDER,
  hasRawNumberedReferenceOverflow
} from "../../../shared/falShotModel";
import { changedFields } from "../renderSpec";

import {
  planShotRun,
  sequentialShotConfig,
  ShotRunError,
  shotSpecsInFlight
} from "./planShotRun";
import {
  SEQUENTIAL_SHOT_REFERENCE_DESCRIPTION,
  SEQUENTIAL_SHOT_REFERENCE_DESCRIPTION_CUT
} from "./sequentialContinuation";

const shot = (index: number, overrides: Record<string, unknown> = {}) => ({
  timeline_id: `shot-${index}`,
  shot_index: index - 1,
  sequence_id: index,
  key: String(index),
  dropped: false,
  video_prompt: `Shot ${index}.`,
  duration_s: 6,
  references: { characters: [{ token: "pilot", asset_id: "sheet-1" }] },
  missing_references: [],
  ...overrides
});

const SETTINGS = { engine: "minimax_h3_max", frame_range: [0, 144] };

const plan = (
  shots: Record<string, unknown>[],
  request: Record<string, unknown> = {},
  extra: {
    cutShots?: Record<string, unknown>[];
    inFlight?: Map<string, Set<string>>;
  } = {}
) =>
  planShotRun({
    shots,
    cutShots: extra.cutShots ?? [],
    request: { videoSettings: SETTINGS, outputSize: [1280, 720], ...request },
    inFlight: extra.inFlight ?? new Map()
  });

const rendered = (
  timelineId: string,
  fingerprint: string,
  assetId = "video-1"
) => ({
  timeline_id: timelineId,
  asset_id: assetId,
  versions: [{ asset_id: assetId, ready: true, fingerprint }]
});

const FRAME_MODES = [
  { mode: "last_frame", opening_frame: "cut" },
  { mode: "last_frame", opening_frame: "off" },
  { mode: "last_frame", opening_frame: "pin" },
  { mode: "key_frames", num_select: 1 },
  { mode: "key_frames", num_select: 4 }
];
const FAL_SETTINGS = { ...SETTINGS, render_provider: FAL_SHOT_PROVIDER };

describe("planShotRun fal sequential frames", () => {
  it.each(
    FRAME_MODES.filter((config) => config.opening_frame !== "pin").flatMap(
      (config) => [false, true].map((sameRun) => ({ config, sameRun }))
    )
  )(
    "allows $config with same-run predecessor: $sameRun",
    ({ config, sameRun }) => {
      const run = plan(
        [
          shot(1),
          shot(2, { references: {}, sequential: { enabled: true, ...config } })
        ],
        {
          videoSettings: FAL_SETTINGS,
          ...(sameRun ? {} : { timelineIds: ["shot-2"] })
        },
        { cutShots: [rendered("shot-1", "old", "previous-video")] }
      );
      expect(run.preview.blocked).toEqual([]);
      const successor = run.planned.find(
        ({ shot }) => shot.timeline_id === "shot-2"
      )!;
      expect(successor).toMatchObject({
        previousTimelineId: "shot-1",
        previousAssetId: sameRun ? null : "previous-video",
        previousInRun: sameRun,
        sequential: {
          mode: config.mode,
          ...(config.opening_frame && config.opening_frame !== "cut"
            ? { opening_frame: config.opening_frame }
            : {}),
          ...(config.num_select ? { num_select: config.num_select } : {})
        }
      });
      if (sameRun)
        expect(successor.renderSpec.spec.sequential).not.toHaveProperty(
          "prev_asset_id"
        );
      else
        expect(successor.renderSpec.spec.sequential).toHaveProperty(
          "prev_asset_id",
          "previous-video"
        );
    }
  );

  it.each(
    [false, true].flatMap((sameRun) =>
      [
        [1280, 720],
        [720, 1280]
      ].map((outputSize) => ({ sameRun, outputSize }))
    )
  )(
    "blocks pin with same-run predecessor: $sameRun and output size: $outputSize",
    ({ sameRun, outputSize }) => {
      const run = plan(
        [
          shot(1),
          shot(2, {
            sequential: {
              enabled: true,
              mode: "last_frame",
              opening_frame: "pin"
            }
          })
        ],
        {
          videoSettings: FAL_SETTINGS,
          outputSize,
          ...(sameRun ? {} : { timelineIds: ["shot-2"] })
        },
        { cutShots: [rendered("shot-1", "old", "previous-video")] }
      );
      expect(run.preview.would_run_timeline_ids).toEqual(
        sameRun ? ["shot-1"] : []
      );
      expect(run.preview.blocked).toEqual([
        expect.objectContaining({
          timeline_id: "shot-2",
          reason_code: "unsupported_opening_frame",
          reason: expect.stringContaining(
            "start image also determines the canvas"
          )
        })
      ]);
    }
  );

  it("blocks previous-shot video inputs with an actionable reason", () => {
    const run = plan(
      [shot(1), shot(2, { sequential: { enabled: true, mode: "last_chunk" } })],
      { videoSettings: FAL_SETTINGS },
      { cutShots: [rendered("shot-1", "old")] }
    );
    expect(run.preview.would_run_timeline_ids).toEqual(["shot-1"]);
    expect(run.preview.blocked).toEqual([
      expect.objectContaining({
        timeline_id: "shot-2",
        reason_code: "fal_sequential_unsupported",
        reason: expect.stringContaining("Previous-shot video inputs")
      })
    ]);
    expect((run.preview.blocked as { reason: string }[])[0]!.reason).toContain(
      "use last_frame or key_frames"
    );
  });

  it.each([...FRAME_MODES, { mode: "last_chunk" }])(
    "ignores $mode continuity on the first shot",
    (config) => {
      const run = plan(
        [shot(1, { sequential: { enabled: true, ...config } })],
        { videoSettings: FAL_SETTINGS }
      );
      expect(run.preview.blocked).toEqual([]);
      expect(run.preview.sequential_ignored).toEqual([
        expect.objectContaining({ timeline_id: "shot-1", reason: "first shot" })
      ]);
      expect(run.planned[0]).toMatchObject({
        sequential: null,
        previousTimelineId: null,
        previousAssetId: null,
        previousInRun: false
      });
      expect(run.planned[0]!.renderSpec.spec).not.toHaveProperty("sequential");
    }
  );
});

describe("planShotRun fal raw numbered reference overflow", () => {
  const references = (count: number) => ({
    characters: Array.from({ length: Math.ceil(count / 2) }, (_, index) => ({
      token: `character-${index}`,
      asset_id: `character-image-${index}`
    })),
    objects: Array.from({ length: Math.floor(count / 2) }, (_, index) => ({
      token: `object-${index}`,
      asset_id: `object-image-${index}`
    }))
  });
  const successor = (overrides: Record<string, unknown> = {}) =>
    shot(2, {
      references: references(9),
      prompt_rewrite: "raw",
      video_prompt: "Follow <Picture 9>.",
      sequential: { enabled: true },
      ...overrides
    });
  const readyPredecessor = {
    cutShots: [rendered("shot-1", "old", "previous-video")]
  };
  const request = {
    videoSettings: FAL_SETTINGS,
    timelineIds: ["shot-2"]
  };

  it.each(
    FRAME_MODES.filter((config) => config.opening_frame !== "pin").flatMap(
      (config) =>
        [false, true].flatMap((sameRun) =>
          ["Follow <Picture 9>.", "Follow Image 9."].map((prompt) => ({
            config,
            sameRun,
            prompt
          }))
        )
    )
  )(
    "blocks nine entities plus $config for $prompt (same run: $sameRun)",
    ({ config, sameRun, prompt }) => {
      const run = plan(
        [
          shot(1),
          successor({
            video_prompt: prompt,
            sequential: { enabled: true, ...config }
          })
        ],
        { ...request, ...(sameRun ? { timelineIds: undefined } : {}) },
        readyPredecessor
      );
      expect(run.preview.would_run_timeline_ids).toEqual(
        sameRun ? ["shot-1"] : []
      );
      expect(run.preview.blocked).toEqual([
        expect.objectContaining({
          timeline_id: "shot-2",
          missing: [],
          reason_code: "raw_reference_overflow",
          reason: expect.stringContaining("8 available slots")
        })
      ]);
      expect(
        (run.preview.blocked as { reason: string }[])[0]!.reason
      ).toContain("use normal prompt composition or reduce reference images");
    }
  );

  it.each(FRAME_MODES.filter((config) => config.opening_frame !== "pin"))(
    "allows eight entities plus $mode continuity without remapping",
    (config) => {
      const prompt = "Follow <Picture 8> and Image 1.";
      const run = plan(
        [
          shot(1),
          successor({
            references: references(8),
            video_prompt: prompt,
            sequential: { enabled: true, ...config },
            _local_storyboard: { asset_id: "unused-raw-board" }
          })
        ],
        request,
        readyPredecessor
      );
      expect(run.preview.blocked).toEqual([]);
      expect(run.preview.would_run_timeline_ids).toEqual(["shot-2"]);
      expect(run.planned[0]!.shot.video_prompt).toBe(prompt);
      expect(run.planned[0]!.shot.references).toEqual(references(8));
      expect(run.planned[0]!.shot._local_storyboard).toBeNull();
      expect(run.planned[0]!.renderSpec.spec).not.toHaveProperty("storyboard");
    }
  );

  it("blocks overflow even when the numbered reference is within the capacity", () => {
    const run = plan(
      [shot(1), successor({ video_prompt: "Follow <Picture 1>." })],
      request,
      readyPredecessor
    );
    expect(run.planned).toEqual([]);
    expect(run.preview.blocked).toContainEqual(
      expect.objectContaining({ reason_code: "raw_reference_overflow" })
    );
  });

  it("allows ordinary unnumbered raw prompts to use overflow contact sheets", () => {
    const run = plan(
      [
        shot(1),
        successor({ video_prompt: "The pilot turns toward the camera." })
      ],
      request,
      readyPredecessor
    );
    expect(run.preview.blocked).toEqual([]);
    expect(run.preview.would_run_timeline_ids).toEqual(["shot-2"]);
  });

  it("allows normal composition, including a shot override of project raw", () => {
    const run = plan(
      [shot(1), successor({ prompt_rewrite: "mago" })],
      {
        ...request,
        videoSettings: { ...FAL_SETTINGS, prompt_rewrite: "raw" }
      },
      readyPredecessor
    );
    expect(run.preview.blocked).toEqual([]);
    expect(run.planned[0]!.promptRewrite).toBe("mago");
  });

  it("applies project raw when the shot does not override it", () => {
    const run = plan(
      [shot(1), successor({ prompt_rewrite: undefined })],
      {
        ...request,
        videoSettings: { ...FAL_SETTINGS, prompt_rewrite: "raw" }
      },
      readyPredecessor
    );
    expect(run.planned).toEqual([]);
    expect(run.preview.blocked).toContainEqual(
      expect.objectContaining({ reason_code: "raw_reference_overflow" })
    );
  });

  it("leaves local raw composition unchanged", () => {
    const run = plan(
      [shot(1), successor()],
      { ...request, videoSettings: SETTINGS },
      readyPredecessor
    );
    expect(run.preview.blocked).toEqual([]);
    expect(run.preview.would_run_timeline_ids).toEqual(["shot-2"]);
  });

  it("allows nine numbered raw entities without a continuity slot", () => {
    const run = plan([successor({ sequential: { enabled: true } })], request);
    expect(run.preview.blocked).toEqual([]);
    expect(run.preview.would_run_timeline_ids).toEqual(["shot-2"]);
    expect(run.planned[0]!.sequential).toBeNull();
  });

  it("blocks ten numbered raw entities even without continuity", () => {
    const run = plan(
      [successor({ references: references(10), sequential: null })],
      request
    );
    expect(run.planned).toEqual([]);
    expect(run.preview.blocked).toContainEqual(
      expect.objectContaining({
        reason_code: "raw_reference_overflow",
        reason: expect.stringContaining("9 available slots")
      })
    );
  });
});

describe("hasRawNumberedReferenceOverflow", () => {
  it.each([
    { prompt: "<Picture 9>", count: 9, capacity: 8, overflow: true },
    { prompt: "Image 9", count: 9, capacity: 8, overflow: true },
    { prompt: "<picture 1>", count: 9, capacity: 8, overflow: true },
    { prompt: "image 1", count: 9, capacity: 8, overflow: true },
    { prompt: "<Picture 8>", count: 8, capacity: 8, overflow: false },
    { prompt: "Image 9", count: 9, capacity: 9, overflow: false },
    { prompt: "<Picture 8>", count: 8, capacity: 7, overflow: true },
    {
      prompt: "A pilot looks at the camera.",
      count: 9,
      capacity: 8,
      overflow: false
    },
    {
      prompt: "Pictures and images of a pilot.",
      count: 9,
      capacity: 8,
      overflow: false
    }
  ])(
    "$prompt: $count references / $capacity slots => $overflow",
    ({ prompt, count, capacity, overflow }) => {
      expect(hasRawNumberedReferenceOverflow(prompt, count, capacity)).toBe(
        overflow
      );
    }
  );
});

describe("planShotRun Comfy sequential pin", () => {
  it.each([false, true])(
    "keeps pin supported with same-run predecessor: %s",
    (sameRun) => {
      const run = plan(
        [
          shot(1),
          shot(2, {
            sequential: {
              enabled: true,
              mode: "last_frame",
              opening_frame: "pin"
            }
          })
        ],
        sameRun ? {} : { timelineIds: ["shot-2"] },
        { cutShots: [rendered("shot-1", "old", "previous-video")] }
      );
      expect(run.preview.blocked).toEqual([]);
      expect(
        run.planned.find(({ shot }) => shot.timeline_id === "shot-2")
      ).toMatchObject({
        sequential: { mode: "last_frame", opening_frame: "pin" },
        previousInRun: sameRun,
        previousAssetId: sameRun ? null : "previous-video"
      });
    }
  );
});

describe.each(["local", "fal"])(
  "planShotRun sequential predecessor decisions (%s)",
  (provider) => {
    const request = {
      videoSettings: provider === "fal" ? FAL_SETTINGS : SETTINGS
    };
    const successor = () => shot(2, { sequential: { enabled: true } });

    it.each([
      { label: "locked", overrides: { locked: true } },
      {
        label: "missing references",
        overrides: { missing_references: [{ token: "pilot" }] }
      },
      { label: "missing prompt", overrides: { video_prompt: "" } },
      { label: "missing image", overrides: { references: {} } },
      { label: "invalid duration", overrides: { duration_s: 2 } }
    ])(
      "blocks a dependent of a $label predecessor without a ready pin",
      ({ overrides }) => {
        const run = plan([shot(1, overrides), successor()], request);
        expect(run.preview.blocked).toContainEqual(
          expect.objectContaining({
            timeline_id: "shot-2",
            reason_code: "predecessor_not_rendered"
          })
        );
        expect(run.planned).toEqual([]);
      }
    );

    it("blocks a named successor without a previous render", () => {
      const run = plan([shot(1), successor()], {
        ...request,
        timelineIds: ["shot-2"]
      });
      expect(run.preview.blocked).toEqual([
        expect.objectContaining({ reason_code: "predecessor_not_rendered" })
      ]);
    });

    it("does not mistake an unfinished pin for a finished predecessor", () => {
      const cut = rendered("shot-1", "old");
      cut.versions[0]!.ready = false;
      const run = plan([shot(1, { locked: true }), successor()], request, {
        cutShots: [cut]
      });
      expect(run.preview.blocked).toEqual([
        expect.objectContaining({ reason_code: "predecessor_not_rendered" })
      ]);
    });

    it("blocks a dependent when its predecessor is already in flight without a pin", () => {
      const first = plan([shot(1)], request).planned[0]!.renderSpec.fingerprint;
      const run = plan([shot(1), successor()], request, {
        inFlight: new Map([["shot-1", new Set([first])]])
      });
      expect(run.preview.skipped).toContainEqual(
        expect.objectContaining({
          timeline_id: "shot-1",
          reason: "render already in progress"
        })
      );
      expect(run.preview.blocked).toEqual([
        expect.objectContaining({
          timeline_id: "shot-2",
          reason_code: "predecessor_not_rendered"
        })
      ]);
    });

    it("blocks when the predecessor's matching rendered fingerprint has no asset", () => {
      const first = plan([shot(1)], request).planned[0]!.renderSpec.fingerprint;
      const run = plan([shot(1), successor()], request, {
        cutShots: [
          {
            timeline_id: "shot-1",
            versions: [{ ready: true, fingerprint: first }]
          }
        ]
      });
      expect(run.preview.blocked).toEqual([
        expect.objectContaining({
          timeline_id: "shot-2",
          reason_code: "predecessor_not_rendered"
        })
      ]);
    });

    it.each([false, true])(
      "fingerprints a changed predecessor pin (locked: %s)",
      (locked) => {
        const first = plan([shot(1)], request).planned[0]!.renderSpec
          .fingerprint;
        const oldCut = rendered("shot-1", first, "previous-v1");
        const shots = [shot(1, { locked }), successor()];
        const old = plan(shots, request, { cutShots: [oldCut] }).planned[0]!;
        expect(old.previousAssetId).toBe("previous-v1");
        const completed = rendered(
          "shot-2",
          old.renderSpec.fingerprint,
          "successor-v1"
        );
        const newCut = {
          ...oldCut,
          pinned_asset_id: "previous-v2",
          versions: [
            ...oldCut.versions,
            { asset_id: "previous-v2", ready: true, fingerprint: first }
          ]
        };
        const run = plan(
          [shots[0]!, { ...successor(), last_spec: old.renderSpec.spec }],
          request,
          { cutShots: [newCut, completed] }
        );
        expect(run.preview.would_run_timeline_ids).toEqual(["shot-2"]);
        expect(run.planned[0]).toMatchObject({
          previousInRun: false,
          previousAssetId: "previous-v2",
          renderSpec: { spec: { sequential: { prev_asset_id: "previous-v2" } } }
        });
        expect(run.planned[0]!.renderSpec.fingerprint).not.toBe(
          old.renderSpec.fingerprint
        );
        expect(run.preview.changed_by_timeline_id).toEqual({
          "shot-2": ["sequential.prev_asset_id"]
        });
      }
    );

    it.each([false, true])(
      "keeps a no-op successor skipped (named: %s)",
      (named) => {
        const first = plan([shot(1)], request).planned[0]!.renderSpec
          .fingerprint;
        const previousCut = rendered("shot-1", first, "previous-video");
        const shots = [shot(1), successor()];
        const next = plan(shots, request, { cutShots: [previousCut] })
          .planned[0]!;
        const run = plan(
          shots,
          { ...request, ...(named ? { timelineIds: ["shot-2"] } : {}) },
          {
            cutShots: [
              previousCut,
              rendered("shot-2", next.renderSpec.fingerprint)
            ]
          }
        );
        expect(run.planned).toEqual([]);
        expect(run.preview.blocked).toEqual([]);
        expect(run.preview.skipped).toContainEqual(
          expect.objectContaining({
            timeline_id: "shot-2",
            reason: "already rendered with these inputs"
          })
        );
      }
    );

    it("does not skip same-run dependents for matching old rendered fingerprints", () => {
      const shots = [
        shot(1),
        successor(),
        shot(3, { sequential: { enabled: true } })
      ];
      const old = plan(shots, request);
      const run = plan(
        [
          shot(1, { video_prompt: "Changed upstream action." }),
          ...shots.slice(1)
        ],
        request,
        {
          cutShots: old.planned.map(({ shot, renderSpec }) =>
            rendered(
              String(shot.timeline_id),
              renderSpec.fingerprint,
              `old-${String(shot.timeline_id)}`
            )
          )
        }
      );
      expect(run.preview.would_run_timeline_ids).toEqual([
        "shot-1",
        "shot-2",
        "shot-3"
      ]);
      for (const dependent of run.planned.slice(1)) {
        expect(dependent.previousInRun).toBe(true);
        expect(dependent.previousAssetId).toBeNull();
        expect(dependent.renderSpec.spec.sequential).not.toHaveProperty(
          "prev_asset_id"
        );
      }
      expect(run.preview.skipped).toEqual([]);
    });

    it("still avoids duplicate in-flight dependent specs", () => {
      const shots = [shot(1), successor()];
      const old = plan(shots, request);
      const dependentFingerprint = old.planned[1]!.renderSpec.fingerprint;
      const run = plan(shots, request, {
        inFlight: new Map([["shot-2", new Set([dependentFingerprint])]])
      });
      expect(run.preview.would_run_timeline_ids).toEqual(["shot-1"]);
      expect(run.preview.skipped).toContainEqual(
        expect.objectContaining({
          timeline_id: "shot-2",
          reason: "render already in progress"
        })
      );
    });
  }
);

describe("planShotRun", () => {
  it("includes visual style in the spec and keeps empty-style fingerprints stable", () => {
    const original = plan([shot(1)]).planned[0]!.renderSpec;
    expect(
      plan([shot(1)], { visualStyle: " " }).planned[0]!.renderSpec
    ).toEqual(original);
    const styled = plan([shot(1)], { visualStyle: "  Ink on paper  " })
      .planned[0]!.renderSpec;
    expect(styled.spec.settings).toMatchObject({
      visual_style: "Ink on paper"
    });
    expect(styled.fingerprint).not.toBe(original.fingerprint);
    expect(changedFields(original.spec, styled.spec)).toContain(
      "settings.visual_style"
    );
  });
  it("reports dropped and locked shots as skipped and missing references as blocked", () => {
    const run = plan([
      shot(1, { dropped: true }),
      shot(2, { locked: true }),
      shot(3, { missing_references: [{ token: "pilot", reason: "no_image" }] }),
      shot(4)
    ]);
    expect(run.preview.skipped).toEqual([
      { sequence_id: 1, key: "1", timeline_id: "shot-1", reason: "dropped" },
      { sequence_id: 2, key: "2", timeline_id: "shot-2", reason: "locked" }
    ]);
    expect(run.preview.blocked).toEqual([
      {
        sequence_id: 3,
        key: "3",
        timeline_id: "shot-3",
        missing: [{ token: "pilot", reason: "no_image" }]
      }
    ]);
    expect(run.preview.would_run_timeline_ids).toEqual(["shot-4"]);
  });

  it("filters on sequence ids OR timeline ids", () => {
    const run = plan([shot(1), shot(2), shot(3)], {
      sequenceIds: [1],
      timelineIds: ["shot-3"]
    });
    expect(run.preview.would_run_keys).toEqual(["1", "3"]);
  });

  it("ignores continuity on the first shot and blocks one with nothing to continue from", () => {
    const run = plan([shot(1), shot(2)], {
      timelineIds: ["shot-1", "shot-2"],
      sequential: { default: { enabled: true } }
    });
    expect(run.preview.sequential_ignored).toEqual([
      { sequence_id: 1, key: "1", timeline_id: "shot-1", reason: "first shot" }
    ]);
    // Shot 1 renders in this run, so shot 2 waits for it.
    expect(run.planned[1]).toEqual(
      expect.objectContaining({
        previousTimelineId: "shot-1",
        previousInRun: true,
        sequential: {
          mode: "last_frame",
          prompt_appendix: SEQUENTIAL_SHOT_REFERENCE_DESCRIPTION_CUT
        }
      })
    );
    expect(
      run.planned[1]!.renderSpec.spec.sequential as Record<string, unknown>
    ).toEqual(
      expect.objectContaining({
        prompt_appendix: SEQUENTIAL_SHOT_REFERENCE_DESCRIPTION
      })
    );

    const alone = plan([shot(1), shot(2)], {
      timelineIds: ["shot-2"],
      sequential: { default: { enabled: true } }
    });
    expect(alone.preview.blocked).toEqual([
      expect.objectContaining({
        timeline_id: "shot-2",
        missing: [],
        reason_code: "predecessor_not_rendered"
      })
    ]);
  });

  it("continues from the predecessor's pin when it is not rendering", () => {
    const run = plan(
      [shot(1), shot(2, { sequential: { enabled: true, mode: "last_chunk" } })],
      {
        timelineIds: ["shot-2"]
      },
      { cutShots: [rendered("shot-1", "sha256:x", "video-1")] }
    );
    expect(run.planned).toHaveLength(1);
    expect(run.planned[0]!.previousInRun).toBe(false);
    expect(run.planned[0]!.renderSpec.spec.sequential).toEqual(
      expect.objectContaining({
        mode: "last_chunk",
        chunk_seconds: 2,
        prev_asset_id: "video-1"
      })
    );
  });

  it("blocks a shot outside the 5-15 s window and refuses the real run", () => {
    const run = plan([shot(1, { duration_s: 4.6 }), shot(2)]);
    expect(run.preview.blocked).toEqual([
      {
        sequence_id: 1,
        key: "1",
        timeline_id: "shot-1",
        missing: [],
        reason_code: "duration_out_of_range",
        reason: "minimax_h3_local renders 5-15s; this shot is 4.6s"
      }
    ]);
    expect(run.durationError).toBe(
      "shot 1: minimax_h3_local renders 5-15s; this shot is 4.6s"
    );
  });

  it("renders a shot with no length at the plan length, reported only as the odd one out", () => {
    const run = plan([shot(1, { duration_s: null }), shot(2)]);
    expect(run.preview.duration_missing).toEqual([
      { sequence_id: 1, key: "1", timeline_id: "shot-1", duration_s: 6 }
    ]);
    expect(run.planned.map((planned) => planned.durationSeconds)).toEqual([
      6, 6
    ]);
    const uncalibrated = plan([shot(1, { duration_s: null })]);
    expect(uncalibrated.preview.duration_missing).toEqual([]);
  });

  it("validates prompt_rewrite and keeps the default pair out of the spec", () => {
    expect(() =>
      plan([shot(1)], {
        videoSettings: { ...SETTINGS, adapt_video_prompt: false }
      })
    ).toThrow(
      "adapt_video_prompt is not settable here; use prompt_rewrite (mago, raw)"
    );
    expect(() =>
      plan([shot(1)], {
        videoSettings: { ...SETTINGS, prompt_rewrite: "fal_quality" }
      })
    ).toThrow(ShotRunError);
    expect(() => plan([shot(1, { prompt_rewrite: "fal_balanced" })])).toThrow(
      "shot 1: prompt_rewrite must be one of: mago, raw (on engine minimax_h3_local)"
    );

    const byDefault = plan([shot(1)], {
      videoSettings: { ...SETTINGS, prompt_rewrite: "mago" }
    });
    expect(byDefault.planned[0]!.renderSpec.spec.settings).toEqual({
      ...SETTINGS,
      duration_s: 6
    });
    expect(byDefault.planned[0]!.renderSpec.fingerprint).toBe(
      plan([shot(1)]).planned[0]!.renderSpec.fingerprint
    );

    const rawShot = plan([shot(1, { prompt_rewrite: "raw" })]);
    expect(rawShot.planned[0]!.promptRewrite).toBe("raw");
    expect(rawShot.planned[0]!.renderSpec.spec.settings).toEqual(
      expect.objectContaining({ adapt_video_prompt: false })
    );
  });

  it("skips a shot already rendered with these inputs or being rendered now", () => {
    const first = plan([shot(1), shot(2)]);
    const [one, two] = first.planned.map(
      (planned) => planned.renderSpec.fingerprint
    );
    const run = plan(
      [shot(1), shot(2)],
      {},
      {
        cutShots: [rendered("shot-1", one!)],
        inFlight: new Map([["shot-2", new Set([two!])]])
      }
    );
    expect(run.preview.skipped).toEqual([
      expect.objectContaining({
        timeline_id: "shot-1",
        reason: "already rendered with these inputs"
      }),
      expect.objectContaining({
        timeline_id: "shot-2",
        reason: "render already in progress"
      })
    ]);
    // Whitespace is not an input.
    const respaced = plan(
      [shot(1, { video_prompt: "  Shot   1. " })],
      {},
      {
        cutShots: [rendered("shot-1", one!)]
      }
    );
    expect(respaced.planned).toEqual([]);
  });

  it("says what changed since the last request", () => {
    const first = plan([shot(1)]);
    const run = plan([
      shot(1, { duration_s: 8, last_spec: first.planned[0]!.renderSpec.spec })
    ]);
    expect(run.preview.changed).toEqual({ "1": ["settings.duration_s"] });
    expect(run.preview.changed_by_timeline_id).toEqual({
      "shot-1": ["settings.duration_s"]
    });
  });
});

describe("planShotRun scene list rules", () => {
  it("skips a hidden shot in a bulk run but renders it when named", () => {
    const bulk = plan([shot(1), shot(2, { hidden: true })]);
    expect(bulk.preview.skipped).toEqual([
      { sequence_id: 2, key: "2", timeline_id: "shot-2", reason: "hidden" }
    ]);

    const named = plan([shot(1), shot(2, { hidden: true })], {
      timelineIds: ["shot-2"]
    });
    expect(named.preview.would_run_timeline_ids).toEqual(["shot-2"]);
  });

  it("continues from the shot before a hidden one", () => {
    const run = plan(
      [shot(1), shot(2, { hidden: true }), shot(3)],
      {
        timelineIds: ["shot-3"],
        sequential: { default: { enabled: true } }
      },
      { cutShots: [rendered("shot-1", "done")] }
    );
    expect(run.planned[0]!.previousTimelineId).toBe("shot-1");
  });

  it("blocks a shot with no prompt", () => {
    const run = plan([shot(1, { video_prompt: "  " })]);
    expect(run.preview.blocked).toEqual([
      expect.objectContaining({
        timeline_id: "shot-1",
        reason_code: "no_prompt"
      })
    ]);
  });

  it("blocks a non-sequential shot with no reference image, also in the dry run", () => {
    const run = plan([shot(1, { references: {} })]);
    expect(run.preview.blocked).toEqual([
      expect.objectContaining({
        timeline_id: "shot-1",
        reason_code: "no_reference_image"
      })
    ]);
    expect(run.planned).toEqual([]);
  });

  it("lets a sequential shot with no reference image continue from its predecessor", () => {
    const run = plan(
      [shot(1), shot(2, { references: {}, sequential: { enabled: true } })],
      {},
      { cutShots: [rendered("shot-1", "done")] }
    );
    expect(run.preview.would_run_timeline_ids).toContain("shot-2");
  });

  it("plans a hand-added shot that belongs to no sequence", () => {
    const run = plan([shot(1, { sequence_id: null, key: "manual-abc" })]);
    expect(run.preview.would_run).toEqual([null]);
    expect(run.preview.would_run_keys).toEqual(["manual-abc"]);
  });
});

describe("sequentialShotConfig", () => {
  it("defaults a last-frame shot to cut and keeps another opening frame", () => {
    expect(sequentialShotConfig({ enabled: true }, null, null)).toEqual([
      {
        mode: "last_frame",
        prompt_appendix: SEQUENTIAL_SHOT_REFERENCE_DESCRIPTION_CUT
      },
      null
    ]);
    expect(
      sequentialShotConfig(
        { enabled: true, opening_frame: "pin" },
        null,
        null
      )[0]
    ).toEqual(expect.objectContaining({ opening_frame: "pin" }));
    expect(
      sequentialShotConfig(
        { enabled: true, opening_frame: "sideways" },
        null,
        null
      )[1]
    ).toBe("sequential.opening_frame must be one of cut, pin, off");
  });

  it("treats a default text saved back as the default, so it follows the opening frame", () => {
    const [config] = sequentialShotConfig(
      {
        enabled: true,
        opening_frame: "off",
        prompt_appendix: SEQUENTIAL_SHOT_REFERENCE_DESCRIPTION_CUT
      },
      null,
      null
    );
    expect(config?.prompt_appendix).toBe(SEQUENTIAL_SHOT_REFERENCE_DESCRIPTION);
  });

  it("merges run default < persisted < run entry and keeps only the mode's knobs", () => {
    expect(
      sequentialShotConfig(
        { enabled: true, mode: "key_frames", chunk_seconds: 3 },
        { num_select: 3 },
        { enabled: false, prompt_appendix: " Match it. " }
      )
    ).toEqual([
      { mode: "key_frames", prompt_appendix: "Match it.", num_select: 3 },
      null
    ]);
    expect(
      sequentialShotConfig({ enabled: true }, { enabled: false }, {})
    ).toEqual([null, null]);
  });

  it("refuses knobs out of range", () => {
    expect(
      sequentialShotConfig({ enabled: true, mode: "sideways" }, null, null)[1]
    ).toBe("sequential.mode must be one of last_frame, key_frames, last_chunk");
    expect(
      sequentialShotConfig(
        { enabled: true, mode: "key_frames", num_select: 5 },
        null,
        null
      )[1]
    ).toBe("sequential.num_select must be an integer in 1..4");
    expect(
      sequentialShotConfig(
        { enabled: true, mode: "last_chunk", chunk_seconds: 11 },
        null,
        null
      )[1]
    ).toBe("sequential.chunk_seconds must be a number in 0..10.0");
  });
});

describe("shotSpecsInFlight", () => {
  it("holds live plans' fingerprints except on a timeline the plan gave up on", () => {
    const target = (timelineId: string, fingerprint: string) => ({
      timeline_id: timelineId,
      _local_render_spec: { fingerprint }
    });
    const inFlight = shotSpecsInFlight([
      {
        status: "RUNNING",
        steps: [{ timeline_id: "shot-2", status: "FAILED" }],
        local_targets: [target("shot-1", "a"), target("shot-2", "b")]
      },
      { status: "COMPLETED", local_targets: [target("shot-3", "c")] }
    ]);
    expect([...inFlight.entries()]).toEqual([["shot-1", new Set(["a"])]]);
  });

  it("releases every shot of a paused plan, which local cannot resume from the panel", () => {
    const inFlight = shotSpecsInFlight([
      {
        status: "PAUSED",
        steps: [],
        local_targets: [
          { timeline_id: "shot-1", _local_render_spec: { fingerprint: "a" } }
        ]
      }
    ]);
    expect(inFlight.size).toBe(0);
  });
});

describe("changedFields", () => {
  it("is empty with nothing to compare against", () => {
    expect(changedFields(undefined, { a: 1 })).toEqual([]);
    expect(
      changedFields({ a: { b: 1 }, c: 2 }, { a: { b: 2 }, c: 2, d: 1 })
    ).toEqual(["a.b", "d"]);
  });
});
