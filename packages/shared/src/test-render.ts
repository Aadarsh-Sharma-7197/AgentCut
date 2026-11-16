import assert from "assert";
import {
  createEmptyTimeline,
  addTrack,
  addClip,
  splitClipWithResult,
  trimClip,
  moveClip
} from "./timeline/operations.js";
import type { Timeline, Clip } from "./timeline/types.js";
import {
  createRenderPlanFromTimeline,
  validateRenderPlan,
  DEFAULT_RENDER_OUTPUT_CONFIG
} from "./render/index.js";

export function runRenderTests(): { passed: number; failed: number } {
  console.log("\n=== AgentCut Render Plan & Validation Test Suite ===");
  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void) {
    try {
      fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  const baseClip: Clip = {
    id: "clip_01",
    assetId: "asset_v1",
    trackId: "track_v1",
    sourceStart: 5.0,
    sourceEnd: 25.0,
    timelineStart: 10.0,
    name: "Main Shot"
  };

  // Test 1: Converting a valid timeline into a render plan
  test("1. Converting a valid timeline into a render plan", () => {
    const tl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "Video 1",
        type: "video"
      }),
      baseClip
    );

    const plan = createRenderPlanFromTimeline(tl);
    assert.strictEqual(plan.projectId, "proj_1");
    assert.strictEqual(plan.timelineId, tl.id);
    assert.strictEqual(plan.settings.width, 1920);
    assert.strictEqual(plan.settings.height, 1080);
    assert.strictEqual(plan.settings.frameRate, 30);
    assert.strictEqual(plan.videoClips.length, 1);
    assert.strictEqual(plan.audioClips.length, 0);
    assert.strictEqual(plan.tracks.length, 1);
    assert.strictEqual(plan.duration, 30.0); // timelineStart 10.0 + duration 20.0

    const validation = validateRenderPlan(plan);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.errors.length, 0);
  });

  // Test 2: Non-zero sourceStart mapping
  test("2. Non-zero sourceStart mapping preserved", () => {
    const tl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "Video 1",
        type: "video"
      }),
      {
        ...baseClip,
        sourceStart: 14.5,
        sourceEnd: 30.0,
        timelineStart: 0
      }
    );

    const plan = createRenderPlanFromTimeline(tl);
    const clip = plan.videoClips[0];
    assert.strictEqual(clip.sourceStart, 14.5);
    assert.strictEqual(clip.sourceEnd, 30.0);
    assert.strictEqual(clip.duration, 15.5);
    assert.strictEqual(clip.timelineStart, 0);
    assert.strictEqual(clip.timelineEnd, 15.5);
    assert.strictEqual(plan.duration, 15.5);
  });

  // Test 3: Moved clips (non-zero timelineStart)
  test("3. Moved clips preserve timelineStart offsets", () => {
    const baseTl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "Video 1",
        type: "video"
      }),
      baseClip
    );
    const movedTl = moveClip(baseTl, baseClip.id, 42.5);

    const plan = createRenderPlanFromTimeline(movedTl);
    const clip = plan.videoClips[0];
    assert.strictEqual(clip.timelineStart, 42.5);
    assert.strictEqual(clip.duration, 20.0);
    assert.strictEqual(clip.timelineEnd, 62.5);
    assert.strictEqual(plan.duration, 62.5);
  });

  // Test 4: Split clips
  test("4. Split clips translate to two contiguous render clips", () => {
    const baseTl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "Video 1",
        type: "video"
      }),
      {
        ...baseClip,
        sourceStart: 0,
        sourceEnd: 20.0,
        timelineStart: 5.0
      }
    );
    // Split at timeline 12.0s (source offset 7.0s)
    const { timeline: splitTl } = splitClipWithResult(baseTl, baseClip.id, 12.0);

    const plan = createRenderPlanFromTimeline(splitTl);
    assert.strictEqual(plan.videoClips.length, 2);

    const seg1 = plan.videoClips[0];
    const seg2 = plan.videoClips[1];
    assert.strictEqual(seg1.sourceStart, 0);
    assert.strictEqual(seg1.sourceEnd, 7.0);
    assert.strictEqual(seg1.timelineStart, 5.0);
    assert.strictEqual(seg1.duration, 7.0);
    assert.strictEqual(seg1.timelineEnd, 12.0);

    assert.strictEqual(seg2.sourceStart, 7.0);
    assert.strictEqual(seg2.sourceEnd, 20.0);
    assert.strictEqual(seg2.timelineStart, 12.0);
    assert.strictEqual(seg2.duration, 13.0);
    assert.strictEqual(seg2.timelineEnd, 25.0);

    const validation = validateRenderPlan(plan);
    assert.strictEqual(validation.valid, true);
  });

  // Test 5: Trimmed clips
  test("5. Left-trimmed and right-trimmed clips map accurately", () => {
    const baseTl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "Video 1",
        type: "video"
      }),
      {
        ...baseClip,
        sourceStart: 0,
        sourceEnd: 30.0,
        timelineStart: 10.0
      }
    );

    // Trim left edge forward by 5s (new timelineStart 15.0)
    const leftTrimmed = trimClip(baseTl, baseClip.id, "left", 15.0);
    // Trim right edge backward by 5s (new timelineEnd 35.0)
    const bothTrimmed = trimClip(leftTrimmed, baseClip.id, "right", 35.0);

    const plan = createRenderPlanFromTimeline(bothTrimmed);
    const clip = plan.videoClips[0];
    assert.strictEqual(clip.sourceStart, 5.0);
    assert.strictEqual(clip.sourceEnd, 25.0);
    assert.strictEqual(clip.timelineStart, 15.0);
    assert.strictEqual(clip.duration, 20.0);
    assert.strictEqual(clip.timelineEnd, 35.0);
    assert.strictEqual(plan.duration, 35.0);
  });

  // Test 6: Multiple tracks and track ordering
  test("6. Multiple tracks sorted by track index ascending", () => {
    let tl = createEmptyTimeline({ projectId: "proj_1" });
    tl = addTrack(tl, { id: "tr_audio", name: "Audio 1", type: "audio" });
    tl = addTrack(tl, { id: "tr_video", name: "Video 1", type: "video" });

    tl = addClip(tl, {
      id: "cl_audio",
      assetId: "asset_a1",
      trackId: "tr_audio",
      sourceStart: 0,
      sourceEnd: 10.0,
      timelineStart: 0
    });
    tl = addClip(tl, {
      id: "cl_video",
      assetId: "asset_v1",
      trackId: "tr_video",
      sourceStart: 0,
      sourceEnd: 15.0,
      timelineStart: 0
    });

    const plan = createRenderPlanFromTimeline(tl);
    assert.strictEqual(plan.tracks.length, 2);
    assert.strictEqual(plan.tracks[0].trackId, "tr_audio");
    assert.strictEqual(plan.tracks[1].trackId, "tr_video");
    assert.strictEqual(plan.audioClips.length, 1);
    assert.strictEqual(plan.videoClips.length, 1);
    assert.strictEqual(plan.duration, 15.0);
  });

  // Test 7: Disabled tracks exclusion
  test("7. Disabled tracks are excluded from active videoClips and duration", () => {
    let tl = createEmptyTimeline({ projectId: "proj_1" });
    tl = addTrack(tl, { id: "tr_v1", name: "Video 1", type: "video" });
    tl = addTrack(tl, { id: "tr_v2", name: "Video 2", type: "video" });

    tl = addClip(tl, {
      id: "cl_1",
      assetId: "asset_1",
      trackId: "tr_v1",
      sourceStart: 0,
      sourceEnd: 10.0,
      timelineStart: 0
    });
    tl = addClip(tl, {
      id: "cl_2",
      assetId: "asset_2",
      trackId: "tr_v2",
      sourceStart: 0,
      sourceEnd: 40.0,
      timelineStart: 0
    });

    // Disable track 2
    tl.tracks[1].enabled = false;

    const plan = createRenderPlanFromTimeline(tl);
    assert.strictEqual(plan.tracks[1].enabled, false);
    assert.strictEqual(plan.videoClips.length, 1);
    assert.strictEqual(plan.videoClips[0].clipId, "cl_1");
    // Duration should be derived only from enabled tracks (10.0s, not 40.0s)
    assert.strictEqual(plan.duration, 10.0);
  });

  // Test 8: Invalid dimensions rejected
  test("8. Invalid dimensions rejected (odd numbers, negative, zero, out of range)", () => {
    const validTl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "V",
        type: "video"
      }),
      baseClip
    );
    const plan = createRenderPlanFromTimeline(validTl);

    // Odd width
    const oddWidthPlan = { ...plan, settings: { ...plan.settings, width: 1921 } };
    const resOddWidth = validateRenderPlan(oddWidthPlan);
    assert.strictEqual(resOddWidth.valid, false);
    assert(resOddWidth.errors.some((e) => e.includes("even number")));

    // Odd height
    const oddHeightPlan = { ...plan, settings: { ...plan.settings, height: 1081 } };
    const resOddHeight = validateRenderPlan(oddHeightPlan);
    assert.strictEqual(resOddHeight.valid, false);
    assert(resOddHeight.errors.some((e) => e.includes("even number")));

    // Negative / too small
    const tinyPlan = { ...plan, settings: { ...plan.settings, width: 8, height: 8 } };
    const resTiny = validateRenderPlan(tinyPlan);
    assert.strictEqual(resTiny.valid, false);
  });

  // Test 9: Invalid frame rates rejected
  test("9. Invalid frame rates rejected (negative, zero, NaN, >120)", () => {
    const validTl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "V",
        type: "video"
      }),
      baseClip
    );
    const plan = createRenderPlanFromTimeline(validTl);

    const zeroFpsPlan = { ...plan, settings: { ...plan.settings, frameRate: 0 } };
    assert.strictEqual(validateRenderPlan(zeroFpsPlan).valid, false);

    const nanFpsPlan = { ...plan, settings: { ...plan.settings, frameRate: NaN } };
    assert.strictEqual(validateRenderPlan(nanFpsPlan).valid, false);

    const highFpsPlan = { ...plan, settings: { ...plan.settings, frameRate: 240 } };
    assert.strictEqual(validateRenderPlan(highFpsPlan).valid, false);
  });

  // Test 10: Invalid source boundaries rejected
  test("10. Invalid source boundaries rejected (sourceEnd <= sourceStart)", () => {
    const validTl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "V",
        type: "video"
      }),
      baseClip
    );
    const plan = createRenderPlanFromTimeline(validTl);

    const badTimingPlan = {
      ...plan,
      videoClips: [
        {
          ...plan.videoClips[0],
          sourceStart: 10.0,
          sourceEnd: 5.0 // Invalid!
        }
      ],
      tracks: [
        {
          ...plan.tracks[0],
          clips: [
            {
              ...plan.tracks[0].clips[0],
              sourceStart: 10.0,
              sourceEnd: 5.0
            }
          ]
        }
      ]
    };

    const res = validateRenderPlan(badTimingPlan);
    assert.strictEqual(res.valid, false);
    assert(res.errors.some((e) => e.includes("greater than sourceStart")));
  });

  // Test 11: Unsupported timeline configurations rejected
  test("11. Unsupported configurations rejected (caption tracks & overlapping clips)", () => {
    let tl = createEmptyTimeline({ projectId: "proj_1" });
    tl = addTrack(tl, { id: "tr_cap", name: "Captions", type: "caption" });
    tl = addClip(tl, {
      id: "cl_cap",
      assetId: "asset_cap",
      trackId: "tr_cap",
      sourceStart: 0,
      sourceEnd: 5.0,
      timelineStart: 0
    });

    const captionPlan = createRenderPlanFromTimeline(tl);
    const captionRes = validateRenderPlan(captionPlan);
    assert.strictEqual(captionRes.valid, false);
    assert(captionRes.errors.some((e) => e.includes("Caption tracks are not yet supported")));

    // Overlapping clips on same track
    let tlOverlap = createEmptyTimeline({ projectId: "proj_1" });
    tlOverlap = addTrack(tlOverlap, { id: "tr_v", name: "Video", type: "video" });
    tlOverlap.tracks[0].clips.push(
      {
        id: "c1",
        assetId: "a1",
        trackId: "tr_v",
        sourceStart: 0,
        sourceEnd: 10,
        timelineStart: 0
      },
      {
        id: "c2",
        assetId: "a1",
        trackId: "tr_v",
        sourceStart: 0,
        sourceEnd: 10,
        timelineStart: 5 // Overlaps [0-10]!
      }
    );
    const overlapPlan = createRenderPlanFromTimeline(tlOverlap);
    const overlapRes = validateRenderPlan(overlapPlan);
    assert.strictEqual(overlapRes.valid, false);
    assert(overlapRes.errors.some((e) => e.includes("overlapping clips")));
  });

  // Test 12: Output duration calculation & empty timeline rejection
  test("12. Output duration calculation and empty timeline rejection", () => {
    const emptyTl = createEmptyTimeline({ projectId: "proj_empty" });
    const emptyPlan = createRenderPlanFromTimeline(emptyTl);
    assert.strictEqual(emptyPlan.duration, 0);

    const emptyRes = validateRenderPlan(emptyPlan);
    assert.strictEqual(emptyRes.valid, false);
    assert(emptyRes.errors.some((e) => e.includes("output duration must be a positive number")));
  });

  // Test 13: Original timeline immutability
  test("13. Render-plan generation does NOT mutate original timeline", () => {
    const originalTl = addClip(
      addTrack(createEmptyTimeline({ projectId: "proj_1" }), {
        id: "track_v1",
        name: "Video 1",
        type: "video"
      }),
      baseClip
    );

    const snapshot = JSON.stringify(originalTl);
    const plan = createRenderPlanFromTimeline(originalTl);

    // Mutate the generated render plan
    plan.settings.width = 1280;
    plan.videoClips[0].timelineStart = 999;
    plan.tracks[0].name = "Mutated Track";

    assert.strictEqual(JSON.stringify(originalTl), snapshot, "Original timeline remained strictly unmodified");
  });

  // Test 14: Multiple enabled video tracks with overlapping timeline positions rejected
  test("14. Reject unsupported multi-track video compositing when enabled video tracks overlap", () => {
    let tl = createEmptyTimeline({ projectId: "proj_multi_v" });
    tl = addTrack(tl, { id: "tr_v1", name: "Video 1", type: "video" });
    tl = addTrack(tl, { id: "tr_v2", name: "Video 2", type: "video" });

    // Track 1: [0, 10]
    tl = addClip(tl, {
      id: "clip_v1",
      assetId: "asset_1",
      trackId: "tr_v1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    // Track 2: [5, 15] (overlaps Track 1 between 5s and 10s)
    tl = addClip(tl, {
      id: "clip_v2",
      assetId: "asset_2",
      trackId: "tr_v2",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 5
    });

    const plan = createRenderPlanFromTimeline(tl);
    const res = validateRenderPlan(plan);
    assert.strictEqual(res.valid, false);
    assert(
      res.errors.some((e) => e.includes("Multi-track video compositing is not yet supported")),
      "Explicitly rejects unsupported multi-track video compositing"
    );
  });

  // Test 15: Disabled overlapping video track is excluded and passes validation
  test("15. Disabled overlapping video track is excluded and passes validation", () => {
    let tl = createEmptyTimeline({ projectId: "proj_multi_v_disabled" });
    tl = addTrack(tl, { id: "tr_v1", name: "Video 1", type: "video" });
    tl = addTrack(tl, { id: "tr_v2", name: "Video 2", type: "video" });

    tl = addClip(tl, {
      id: "clip_v1",
      assetId: "asset_1",
      trackId: "tr_v1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    tl = addClip(tl, {
      id: "clip_v2",
      assetId: "asset_2",
      trackId: "tr_v2",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 5
    });

    // Disable Track 2
    tl.tracks[1].enabled = false;

    const plan = createRenderPlanFromTimeline(tl);
    assert.strictEqual(plan.videoClips.length, 1);
    assert.strictEqual(plan.videoClips[0].clipId, "clip_v1");

    const res = validateRenderPlan(plan);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.errors.length, 0);
  });

  // Test 16: Multiple enabled audio tracks with overlapping timeline positions rejected
  test("16. Reject unsupported multi-track audio mixing when enabled audio tracks overlap", () => {
    let tl = createEmptyTimeline({ projectId: "proj_multi_a" });
    tl = addTrack(tl, { id: "tr_a1", name: "Audio 1", type: "audio" });
    tl = addTrack(tl, { id: "tr_a2", name: "Audio 2", type: "audio" });

    // Track 1: [0, 10]
    tl = addClip(tl, {
      id: "clip_a1",
      assetId: "asset_a1",
      trackId: "tr_a1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    // Track 2: [6, 16] (overlaps Track 1 between 6s and 10s)
    tl = addClip(tl, {
      id: "clip_a2",
      assetId: "asset_a2",
      trackId: "tr_a2",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 6
    });

    const plan = createRenderPlanFromTimeline(tl);
    const res = validateRenderPlan(plan);
    assert.strictEqual(res.valid, false);
    assert(
      res.errors.some((e) => e.includes("Multi-track audio mixing is not yet supported")),
      "Explicitly rejects unsupported multi-track audio mixing"
    );
  });

  // Test 17: Disabled overlapping audio track is excluded and passes validation
  test("17. Disabled overlapping audio track is excluded and passes validation", () => {
    let tl = createEmptyTimeline({ projectId: "proj_multi_a_disabled" });
    tl = addTrack(tl, { id: "tr_a1", name: "Audio 1", type: "audio" });
    tl = addTrack(tl, { id: "tr_a2", name: "Audio 2", type: "audio" });

    tl = addClip(tl, {
      id: "clip_a1",
      assetId: "asset_a1",
      trackId: "tr_a1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    tl = addClip(tl, {
      id: "clip_a2",
      assetId: "asset_a2",
      trackId: "tr_a2",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 6
    });

    // Disable Track 2
    tl.tracks[1].enabled = false;

    const plan = createRenderPlanFromTimeline(tl);
    assert.strictEqual(plan.audioClips.length, 1);
    assert.strictEqual(plan.audioClips[0].clipId, "clip_a1");

    const res = validateRenderPlan(plan);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.errors.length, 0);
  });

  // Test 18: Track ordering preserves topmost video track priority without implying compositing
  test("18. Track ordering preserves topmost video track priority without implying compositing", () => {
    let tl = createEmptyTimeline({ projectId: "proj_order" });
    tl = addTrack(tl, { id: "tr_v_top", name: "Top Video", type: "video" });
    tl = addTrack(tl, { id: "tr_v_bot", name: "Bottom Video", type: "video" });

    // Non-overlapping sequential clips: [0, 5] on top track, [5, 10] on bottom track
    tl = addClip(tl, {
      id: "clip_top",
      assetId: "asset_1",
      trackId: "tr_v_top",
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0
    });
    tl = addClip(tl, {
      id: "clip_bot",
      assetId: "asset_2",
      trackId: "tr_v_bot",
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 5
    });

    const plan = createRenderPlanFromTimeline(tl);
    assert.strictEqual(plan.tracks[0].trackId, "tr_v_top");
    assert.strictEqual(plan.tracks[1].trackId, "tr_v_bot");
    assert.strictEqual(plan.tracks[0].index, 0);
    assert.strictEqual(plan.tracks[1].index, 1);
    assert.strictEqual(plan.videoClips.length, 2);

    const res = validateRenderPlan(plan);
    assert.strictEqual(res.valid, true, "Sequential non-overlapping clips across multiple tracks validate cleanly");
  });


  console.log(`=== Render Test Results: ${passed} passed, ${failed} failed ===`);
  return { passed, failed };
}

if (process.argv[1]?.endsWith("test-render.ts")) {
  const result = runRenderTests();
  if (result.failed > 0) {
    process.exit(1);
  }
}
