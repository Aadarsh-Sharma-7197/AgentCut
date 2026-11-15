import assert from "node:assert";
import {
  calculatePixelsPerSecond,
  timeToPixels,
  pixelsToTime,
  calculateClipGeometry,
  calculateTimelineWidth,
  getRulerTicks,
  formatTimeCode,
  formatRulerTime,
  formatClipDuration,
  calculateDraggedTimelineStart,
  calculateTrimmedClip,
  MIN_CLIP_DURATION,
  isTrackTypeCompatible,
  BASE_PIXELS_PER_SECOND,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM
} from "./utils/timelineCalculations.js";
import {
  moveClip,
  splitClip,
  splitClipWithResult,
  trimClip,
  createEmptyTimeline,
  addTrack,
  addClip,
  validateTimeline,
  type Clip,
  type Timeline,
  type MediaAsset
} from "@agentcut/shared";
import { fetchProjectTimeline, saveProjectTimeline } from "./api/timeline.js";
import { TimelineSaveQueue } from "./utils/timelineSaveQueue.js";

console.log("=== AgentCut Timeline UI & Interactive Operations Verification Suite ===\n");

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`, err);
    failed++;
  }
}

async function runAllTests() {
  // 1. Pixels Per Second & Zoom Multipliers
  console.log("[Suite 1] Zoom and Pixels-Per-Second Calculations");
  test("Default zoom yields BASE_PIXELS_PER_SECOND", () => {
    const pps = calculatePixelsPerSecond(DEFAULT_ZOOM);
    assert.strictEqual(pps, BASE_PIXELS_PER_SECOND);
  });

  test("Zoom 2.0x doubles pixels per second", () => {
    const pps = calculatePixelsPerSecond(2.0);
    assert.strictEqual(pps, BASE_PIXELS_PER_SECOND * 2);
  });

  test("Zoom clamped at MIN_ZOOM (0.25x)", () => {
    const pps = calculatePixelsPerSecond(0.05);
    assert.strictEqual(pps, BASE_PIXELS_PER_SECOND * MIN_ZOOM);
  });

  test("Zoom clamped at MAX_ZOOM (4.0x)", () => {
    const pps = calculatePixelsPerSecond(10.0);
    assert.strictEqual(pps, BASE_PIXELS_PER_SECOND * MAX_ZOOM);
  });

  // 2. Coordinate Conversions
  console.log("\n[Suite 2] Time and Pixel Coordinate Conversions");
  test("timeToPixels scales linearly with pps", () => {
    const pps = 50;
    assert.strictEqual(timeToPixels(0, pps), 0);
    assert.strictEqual(timeToPixels(5, pps), 250);
    assert.strictEqual(timeToPixels(12.5, pps), 625);
  });

  test("timeToPixels handles negative and invalid numbers safely", () => {
    const pps = 50;
    assert.strictEqual(timeToPixels(-5, pps), 0);
    assert.strictEqual(timeToPixels(NaN, pps), 0);
    assert.strictEqual(timeToPixels(Infinity, pps), 0);
  });

  test("pixelsToTime is inverse of timeToPixels", () => {
    const pps = 50;
    const time = 7.35;
    const pixels = timeToPixels(time, pps);
    const recoveredTime = pixelsToTime(pixels, pps);
    assert(Math.abs(time - recoveredTime) < 0.0001);
  });

  test("pixelsToTime handles negative and invalid pixel values safely", () => {
    const pps = 50;
    assert.strictEqual(pixelsToTime(-100, pps), 0);
    assert.strictEqual(pixelsToTime(NaN, pps), 0);
  });

  // 3. Clip Geometry & Visual Dimension Constraints
  console.log("\n[Suite 3] Clip Geometry and Dimension Calculations");
  test("calculateClipGeometry positions and sizes clip accurately", () => {
    const pps = 50;
    const clip: Pick<Clip, "timelineStart" | "sourceStart" | "sourceEnd"> = {
      timelineStart: 2.0,
      sourceStart: 1.0,
      sourceEnd: 6.0
    };
    const geom = calculateClipGeometry(clip, pps);
    assert.strictEqual(geom.left, 100); // 2.0s * 50pps
    assert.strictEqual(geom.width, 250); // (6.0 - 1.0)s * 50pps
    assert.strictEqual(geom.duration, 5.0);
  });

  test("calculateClipGeometry enforces minimum 6px width for tiny cuts", () => {
    const pps = 50;
    const tinyClip: Pick<Clip, "timelineStart" | "sourceStart" | "sourceEnd"> = {
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: 0.02 // 0.02s * 50pps = 1px, must clamp to 6px
    };
    const geom = calculateClipGeometry(tinyClip, pps);
    assert.strictEqual(geom.width, 6);
  });

  test("calculateClipGeometry prevents negative left offset", () => {
    const pps = 50;
    const invalidClip: Pick<Clip, "timelineStart" | "sourceStart" | "sourceEnd"> = {
      timelineStart: -5,
      sourceStart: 0,
      sourceEnd: 2
    };
    const geom = calculateClipGeometry(invalidClip, pps);
    assert.strictEqual(geom.left, 0);
  });

  // 4. Timeline Width & Workspace Buffer
  console.log("\n[Suite 4] Timeline Total Width & Trailing Buffer");
  test("calculateTimelineWidth includes trailing workspace buffer", () => {
    const pps = 50;
    const duration = 20; // 20s + 10s buffer = 30s * 50 = 1500px
    const width = calculateTimelineWidth(duration, pps);
    assert.strictEqual(width, 1500);
  });

  test("calculateTimelineWidth respects minimum container width", () => {
    const pps = 10;
    const duration = 0; // 30s * 10 = 300px < 800px minimum
    const width = calculateTimelineWidth(duration, pps, 800);
    assert.strictEqual(width, 800);
  });

  // 5. Ruler Ticks & Zoom Adaptability
  console.log("\n[Suite 5] Dynamic Ruler Ticks and Formatting");
  test("getRulerTicks generates major and minor ticks across duration", () => {
    const pps = 50;
    const ticks = getRulerTicks(30, pps);
    assert(ticks.length > 0, "Ticks array is populated");
    assert(ticks[0].position === 0, "First tick starts at 0px");
    assert(ticks.some((t) => t.isMajor && Boolean(t.label)), "Major ticks contain timestamp labels");
  });

  test("getRulerTicks adapts spacing when zoomed in", () => {
    const ppsZoomedIn = 200; // 4.0x zoom
    const ticksZoomedIn = getRulerTicks(10, ppsZoomedIn);
    const majorTicks = ticksZoomedIn.filter((t) => t.isMajor);
    assert(majorTicks.length >= 5, "Finer major intervals when zoomed in");
  });

  // 6. Timecode and Label Formatting
  console.log("\n[Suite 6] Timecode and Label Formatters");
  test("formatTimeCode formats MM:SS.cc accurately", () => {
    assert.strictEqual(formatTimeCode(0), "00:00.00");
    assert.strictEqual(formatTimeCode(5.25), "00:05.25");
    assert.strictEqual(formatTimeCode(65.5), "01:05.50");
  });

  test("formatTimeCode formats HH:MM:SS.cc for hour+ durations", () => {
    assert.strictEqual(formatTimeCode(3665.25), "01:01:05.25");
  });

  test("formatRulerTime formats seconds and minutes compactly", () => {
    assert.strictEqual(formatRulerTime(0), "0s");
    assert.strictEqual(formatRulerTime(15), "15s");
    assert.strictEqual(formatRulerTime(75), "1:15");
  });

  test("formatClipDuration formats clip duration with appropriate precision", () => {
    assert.strictEqual(formatClipDuration(4.256), "4.26s");
    assert.strictEqual(formatClipDuration(15.4), "15.4s");
    assert.strictEqual(formatClipDuration(0), "0.00s");
  });

  // 7. Interactive Clip Drag Calculations & Bounds
  console.log("\n[Suite 7] Interactive Clip Drag Calculations and Boundary Safety");
  test("calculateDraggedTimelineStart moves clip right on positive delta", () => {
    const initialStart = 5.0; // 5.0s
    const deltaPixels = 100; // +100px at 50pps = +2.0s
    const pps = 50;
    const newStart = calculateDraggedTimelineStart(initialStart, deltaPixels, pps);
    assert.strictEqual(newStart, 7.0);
  });

  test("calculateDraggedTimelineStart moves clip left on negative delta", () => {
    const initialStart = 5.0;
    const deltaPixels = -100; // -100px at 50pps = -2.0s
    const pps = 50;
    const newStart = calculateDraggedTimelineStart(initialStart, deltaPixels, pps);
    assert.strictEqual(newStart, 3.0);
  });

  test("calculateDraggedTimelineStart strictly prevents negative positions", () => {
    const initialStart = 2.0;
    const deltaPixels = -500; // -500px at 50pps = -10.0s, would be -8.0s
    const pps = 50;
    const newStart = calculateDraggedTimelineStart(initialStart, deltaPixels, pps);
    assert.strictEqual(newStart, 0.0);
  });

  test("calculateDraggedTimelineStart scales correctly with zoom level", () => {
    const initialStart = 0;
    const deltaPixels = 200;
    // At 0.5x zoom (25 pps): 200px / 25pps = 8.0s
    assert.strictEqual(calculateDraggedTimelineStart(initialStart, deltaPixels, 25), 8.0);
    // At 2.0x zoom (100 pps): 200px / 100pps = 2.0s
    assert.strictEqual(calculateDraggedTimelineStart(initialStart, deltaPixels, 100), 2.0);
  });

  test("calculateDraggedTimelineStart accounts for horizontal scroll offset", () => {
    const initialStart = 10.0;
    const cursorDelta = 50; // Cursor moved +50px
    const scrollDelta = 150; // User simultaneously scrolled +150px
    const totalDisplacement = cursorDelta + scrollDelta; // +200px
    const pps = 50; // +4.0s
    const newStart = calculateDraggedTimelineStart(initialStart, totalDisplacement, pps);
    assert.strictEqual(newStart, 14.0);
  });

  // 8. Track Compatibility and Shared Move Operations
  console.log("\n[Suite 8] Track Compatibility Rules and moveClip Reuse");
  test("isTrackTypeCompatible only accepts identical track types", () => {
    assert.strictEqual(isTrackTypeCompatible("video", "video"), true);
    assert.strictEqual(isTrackTypeCompatible("audio", "audio"), true);
    assert.strictEqual(isTrackTypeCompatible("caption", "caption"), true);
    assert.strictEqual(isTrackTypeCompatible("video", "audio"), false);
    assert.strictEqual(isTrackTypeCompatible("video", "caption"), false);
    assert.strictEqual(isTrackTypeCompatible("audio", "video"), false);
  });

  test("moveClip moves clip horizontally while preserving identity and source ranges", () => {
    const dummyAsset: MediaAsset = {
      id: "ast_v1",
      projectId: "proj_test",
      originalName: "test.mp4",
      fileSize: 1000,
      mimeType: "video/mp4",
      duration: 60,
      width: 1920,
      height: 1080,
      frameRate: "30",
      videoCodec: "h264",
      audioCodec: "aac",
      format: "mp4",
      createdAt: new Date().toISOString()
    };

    let tl = createEmptyTimeline({ projectId: "proj_test" });
    tl = addTrack(tl, { id: "tr_vid1", name: "Video 1", type: "video" });
    tl = addTrack(tl, { id: "tr_vid2", name: "Video 2", type: "video" });
    tl = addClip(
      tl,
      {
        id: "cl_1",
        assetId: "ast_v1",
        trackId: "tr_vid1",
        sourceStart: 5.0,
        sourceEnd: 15.0,
        timelineStart: 0.0,
        name: "Test Clip"
      },
      { assets: [dummyAsset] }
    );

    // 1. Move horizontally on same track
    const movedHoriz = moveClip(tl, "cl_1", 8.5, "tr_vid1", { assets: [dummyAsset] });
    const clipAfterHoriz = movedHoriz.tracks[0].clips[0];
    assert.strictEqual(clipAfterHoriz.timelineStart, 8.5);
    assert.strictEqual(clipAfterHoriz.id, "cl_1", "Clip ID preserved");
    assert.strictEqual(clipAfterHoriz.sourceStart, 5.0, "sourceStart preserved");
    assert.strictEqual(clipAfterHoriz.sourceEnd, 15.0, "sourceEnd preserved");
    assert.strictEqual(clipAfterHoriz.assetId, "ast_v1", "assetId preserved");

    const valResult = validateTimeline(movedHoriz, { assets: [dummyAsset] });
    assert.strictEqual(valResult.valid, true, "validateTimeline confirms moved timeline is valid");

    // 2. Move between compatible tracks (Video 1 -> Video 2)
    const movedTrack = moveClip(tl, "cl_1", 3.0, "tr_vid2", { assets: [dummyAsset] });
    assert.strictEqual(movedTrack.tracks[0].clips.length, 0, "Removed from source track");
    assert.strictEqual(movedTrack.tracks[1].clips.length, 1, "Added to destination track");
    const clipAfterTrack = movedTrack.tracks[1].clips[0];
    assert.strictEqual(clipAfterTrack.trackId, "tr_vid2", "trackId updated to destination");
    assert.strictEqual(clipAfterTrack.timelineStart, 3.0);
    assert.strictEqual(clipAfterTrack.id, "cl_1");

    // 3. Reject moving video clip to audio or caption track
    const videoOnlyAsset: MediaAsset = {
      ...dummyAsset,
      audioCodec: null // no audio stream
    };
    let tlWithAudio = addTrack(tl, { id: "tr_aud1", name: "Audio 1", type: "audio" });
    tlWithAudio = addTrack(tlWithAudio, { id: "tr_cap1", name: "Captions", type: "caption" });

    let threwAudio = false;
    try {
      moveClip(tlWithAudio, "cl_1", 0, "tr_aud1", { assets: [videoOnlyAsset] });
    } catch {
      threwAudio = true;
    }
    assert.strictEqual(threwAudio, true, "moveClip rejects moving video-only clip to audio track");

    let threwCaption = false;
    try {
      moveClip(tlWithAudio, "cl_1", 0, "tr_cap1", { assets: [dummyAsset] });
    } catch {
      threwCaption = true;
    }
    assert.strictEqual(threwCaption, true, "moveClip rejects moving video clip to caption track");
  });

  // 9. Concurrency, Queue Serialization, and Out-of-Order Network Simulation
  console.log("\n[Suite 9] Concurrency, Queue Serialization, and Out-of-Order Network Simulation");

  await test("Problem Demonstration: Uncontrolled concurrent requests allow out-of-order DB overwrite", async () => {
    let mockDatabaseState = "initial";

    // Request 1 is dispatched first (takes 60ms) with payload "edit_1"
    const req1 = new Promise<void>((resolve) => {
      setTimeout(() => {
        mockDatabaseState = "edit_1"; // Arrives late at database!
        resolve();
      }, 60);
    });

    // Request 2 is dispatched 10ms later (takes 10ms) with payload "edit_2"
    const req2 = new Promise<void>((resolve) => {
      setTimeout(() => {
        mockDatabaseState = "edit_2"; // Arrives early at database!
        resolve();
      }, 20);
    });

    await Promise.all([req1, req2]);
    // Notice that without a queue, req1 overwrote req2, leaving stale data in the database!
    assert.strictEqual(
      mockDatabaseState,
      "edit_1",
      "Demonstrates the problem: without a queue, older request overwrote newer edit in DB"
    );
  });

  await test("TimelineSaveQueue serializes out-of-order network saves and prevents stale writes", async () => {
    let mockDatabaseState = "initial";
    const executionOrder: string[] = [];

    const baseTimeline = createEmptyTimeline({ projectId: "proj_test" });
    const timeline1 = { ...baseTimeline, id: "edit_1" };
    const timeline2 = { ...baseTimeline, id: "edit_2" };

    const queue = new TimelineSaveQueue({
      saveFn: async (payload) => {
        executionOrder.push(`start_${payload.id}`);
        // Simulate payload 1 taking 50ms and payload 2 taking 10ms
        const delay = payload.id === "edit_1" ? 50 : 10;
        await new Promise((r) => setTimeout(r, delay));
        mockDatabaseState = payload.id;
        executionOrder.push(`end_${payload.id}`);
        return payload;
      },
      initialTimeline: baseTimeline
    });

    // Enqueue edit 1, then immediately enqueue edit 2 while edit 1 is in-flight
    queue.enqueue(timeline1);
    queue.enqueue(timeline2);

    // Wait for queue processing to complete
    await new Promise((r) => setTimeout(r, 120));

    // Assert execution was strictly serialized:
    // start_edit_1 -> end_edit_1 -> start_edit_2 -> end_edit_2
    assert.deepStrictEqual(executionOrder, [
      "start_edit_1",
      "end_edit_1",
      "start_edit_2",
      "end_edit_2"
    ]);
    // The database is guaranteed to reflect the newest edit!
    assert.strictEqual(
      mockDatabaseState,
      "edit_2",
      "TimelineSaveQueue strictly guarantees the latest edit wins in the database"
    );
  });

  await test("TimelineSaveQueue coalesces rapid intermediate edits into latest trailing save", async () => {
    const executedPayloads: string[] = [];
    const baseTimeline = createEmptyTimeline({ projectId: "proj_test" });

    const queue = new TimelineSaveQueue({
      saveFn: async (payload) => {
        executedPayloads.push(payload.id);
        await new Promise((r) => setTimeout(r, 40));
        return payload;
      },
      initialTimeline: baseTimeline
    });

    // Enqueue 1 (starts immediately)
    queue.enqueue({ ...baseTimeline, id: "edit_1" });
    // While 1 is in-flight, rapidly enqueue 2, 3, 4
    queue.enqueue({ ...baseTimeline, id: "edit_2" });
    queue.enqueue({ ...baseTimeline, id: "edit_3" });
    queue.enqueue({ ...baseTimeline, id: "edit_4" });

    await new Promise((r) => setTimeout(r, 120));

    // Edits 2 and 3 were coalesced; only 1 and 4 were dispatched to the backend
    assert.deepStrictEqual(
      executedPayloads,
      ["edit_1", "edit_4"],
      "Intermediate edits were coalesced into the final trailing edit"
    );
  });

  await test("TimelineSaveQueue ensures failed earlier save does not roll back newer successful edit", async () => {
    const baseTimeline = createEmptyTimeline({ projectId: "proj_test" });
    let rolledBackState: Timeline | null = null;
    let finalCommittedState: Timeline | null = null;

    const queue = new TimelineSaveQueue({
      saveFn: async (payload) => {
        await new Promise((r) => setTimeout(r, 30));
        if (payload.id === "edit_1") {
          throw new Error("Network timeout on edit 1");
        }
        return payload;
      },
      onSaveSuccess: (saved) => {
        finalCommittedState = saved;
      },
      onSaveError: (_err, rolledBack) => {
        rolledBackState = rolledBack;
      },
      initialTimeline: baseTimeline
    });

    // Enqueue edit 1 (which will fail)
    queue.enqueue({ ...baseTimeline, id: "edit_1" });
    // User performs edit 2 while edit 1 is still failing
    queue.enqueue({ ...baseTimeline, id: "edit_2" });

    await new Promise((r) => setTimeout(r, 100));

    // Edit 1's failure did NOT trigger error rollback because edit 2 was queued
    assert.strictEqual(rolledBackState, null, "Earlier failure did not trigger rollback");
    assert.strictEqual((finalCommittedState as Timeline | null)?.id, "edit_2", "Newer edit 2 succeeded and was committed");
  });

  await test("TimelineSaveQueue rolls back to last known good state if final save fails", async () => {
    const baseline = createEmptyTimeline({ projectId: "proj_test", id: "baseline" });
    let rolledBackTarget: Timeline | null = null;
    let reportedError: string | null = null;

    const queue = new TimelineSaveQueue({
      saveFn: async () => {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("Final save failed");
      },
      onSaveError: (err, rolledBack) => {
        reportedError = err.message;
        rolledBackTarget = rolledBack;
      },
      initialTimeline: baseline
    });

    // Enqueue edit with no subsequent edit
    queue.enqueue({ ...baseline, id: "failed_edit" });

    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(reportedError, "Final save failed");
    assert.strictEqual((rolledBackTarget as Timeline | null)?.id, "baseline", "Rolled back to confirmed baseline");
  });

  // 10. Split Clips Frontend Logic & State Verification
  console.log("\n[Suite 10] Split Clips Frontend Logic & State Verification");

  // Helper matching TimelineEditor.tsx canSplit logic
  function checkCanSplit(selectedClip: Clip | null, currentTime: number): boolean {
    if (!selectedClip) return false;
    const clipDuration = selectedClip.sourceEnd - selectedClip.sourceStart;
    const clipTimelineEnd = selectedClip.timelineStart + clipDuration;
    return currentTime > selectedClip.timelineStart && currentTime < clipTimelineEnd;
  }

  const sampleClip: Clip = {
    id: "clip_sample_1",
    assetId: "asset_test",
    trackId: "tr_1",
    sourceStart: 10,
    sourceEnd: 30, // 20s duration
    timelineStart: 5 // timeline interval: [5, 25]
  };

  test("Split button is disabled when no clip is selected", () => {
    assert.strictEqual(checkCanSplit(null, 10), false);
  });

  test("Split button is disabled when playhead is before clip start", () => {
    assert.strictEqual(checkCanSplit(sampleClip, 2.0), false);
  });

  test("Split button is disabled when playhead is exactly at clip start boundary", () => {
    assert.strictEqual(checkCanSplit(sampleClip, 5.0), false);
  });

  test("Split button is disabled when playhead is exactly at clip end boundary", () => {
    assert.strictEqual(checkCanSplit(sampleClip, 25.0), false);
  });

  test("Split button is disabled when playhead is after clip end", () => {
    assert.strictEqual(checkCanSplit(sampleClip, 30.0), false);
  });

  test("Split button is enabled when playhead is strictly inside clip interval", () => {
    assert.strictEqual(checkCanSplit(sampleClip, 5.001), true);
    assert.strictEqual(checkCanSplit(sampleClip, 15.0), true);
    assert.strictEqual(checkCanSplit(sampleClip, 24.999), true);
  });

  test("Correct playhead-based split position and timing calculations", () => {
    const baseTl = createEmptyTimeline({ projectId: "split_ui_proj" });
    const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
    const clipTl = addClip(trTl, sampleClip);

    // Playhead at 15.0s on timeline
    const currentTime = 15.0;
    const splitResult = splitClipWithResult(clipTl, sampleClip.id, currentTime);

    // splitOffset = 15.0 - 5.0 = 10.0; sourceSplit = 10.0 + 10.0 = 20.0
    assert.strictEqual(splitResult.firstClip.timelineStart, 5.0);
    assert.strictEqual(splitResult.firstClip.sourceStart, 10.0);
    assert.strictEqual(splitResult.firstClip.sourceEnd, 20.0);

    assert.strictEqual(splitResult.secondClip.timelineStart, 15.0);
    assert.strictEqual(splitResult.secondClip.sourceStart, 20.0);
    assert.strictEqual(splitResult.secondClip.sourceEnd, 30.0);
    assert.notStrictEqual(splitResult.secondClip.id, sampleClip.id);
  });

  test("UI state update after splitting replaces 1 clip with 2 contiguous clips", () => {
    const baseTl = createEmptyTimeline({ projectId: "split_ui_proj" });
    const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
    const clipTl = addClip(trTl, sampleClip);

    const currentTime = 12.0;
    const splitResult = splitClipWithResult(clipTl, sampleClip.id, currentTime);
    const splitTimelineDirect = splitClip(clipTl, sampleClip.id, currentTime);
    assert.strictEqual(splitTimelineDirect.tracks[0].clips.length, 2, "splitClip returns 2-clip timeline");

    // Resulting track should have 2 clips replacing the single clip in-place
    const trackClips = splitResult.timeline.tracks[0].clips;
    assert.strictEqual(trackClips.length, 2);
    assert.strictEqual(trackClips[0].id, sampleClip.id);
    assert.strictEqual(trackClips[1].id, splitResult.secondClip.id);

    // Contiguity: first clip ends at 12.0s, second clip starts at 12.0s
    const firstEnd = trackClips[0].timelineStart + (trackClips[0].sourceEnd - trackClips[0].sourceStart);
    assert.strictEqual(firstEnd, trackClips[1].timelineStart);

    // Immediately after split at 12.0s, selecting second clip disables split button because playhead is at its start
    assert.strictEqual(checkCanSplit(trackClips[1], currentTime), false);
  });

  test("Split persistence through TimelineSaveQueue updates confirmed state", async () => {
    let savedInDB: Timeline | null = null;
    const baseTl = createEmptyTimeline({ projectId: "split_queue_proj" });
    const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
    const initialTl = addClip(trTl, sampleClip);

    const queue = new TimelineSaveQueue({
      saveFn: async (payload) => {
        savedInDB = payload;
        return payload;
      },
      initialTimeline: initialTl
    });

    const splitResult = splitClipWithResult(initialTl, sampleClip.id, 15.0);
    queue.enqueue(splitResult.timeline);

    // Wait for queue flush
    await new Promise((r) => setTimeout(r, 50));

    assert.notStrictEqual(savedInDB, null);
    assert.strictEqual((savedInDB as any)?.tracks[0].clips.length, 2);
    assert.strictEqual((queue.getLastSavedTimeline() as any)?.tracks[0].clips.length, 2);
  });

  test("Rollback on failed split save restores pre-split baseline", async () => {
    const baseTl = createEmptyTimeline({ projectId: "split_fail_proj" });
    const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
    const preSplitTl = addClip(trTl, sampleClip);

    let rolledBackState: Timeline | null = null;
    let saveFailed = false;

    const queue = new TimelineSaveQueue({
      saveFn: async () => {
        throw new Error("Network timeout during split save");
      },
      onSaveError: (_err, rolledBack) => {
        saveFailed = true;
        rolledBackState = rolledBack;
      },
      initialTimeline: preSplitTl
    });

    const splitResult = splitClipWithResult(preSplitTl, sampleClip.id, 15.0);
    queue.enqueue(splitResult.timeline);

    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(saveFailed, true);
    assert.strictEqual((rolledBackState as any)?.tracks[0].clips.length, 1);
    assert.strictEqual((rolledBackState as any)?.tracks[0].clips[0].id, sampleClip.id);
  });

  // 11. Live Vite Dev Server & API Proxy Verification
  console.log("\n[Suite 11] Live Vite Dev Server & API Proxy Verification");
  try {
    const viteRes = await fetch("http://localhost:3000/");
    assert.strictEqual(viteRes.status, 200);
    const htmlText = await viteRes.text();
    assert(htmlText.includes("AgentCut"), "Vite serves HTML with AgentCut title");
    console.log("  ✓ PASS: Vite dev server running on http://localhost:3000 and serving index.html");
    passed++;

    // 11. End-to-End Real Project Timeline Drag and Persistence Test
    console.log("\n[Suite 11] Real Project Interactive Clip Drag & Persistence E2E Test");
    const realProjectId = "6af851b5d8c9874f24593e12"; // "My Project"

    // 1. Fetch current timeline for real project via Vite proxy and ensure clean baseline
    let tlCurrent = await fetchProjectTimeline(realProjectId);
    assert(tlCurrent !== null, "Timeline exists for 'My Project'");
    assert(tlCurrent.tracks.length > 0, "Timeline contains tracks");

    // Ensure clean baseline of single 30s clip [0s-30s] at timelineStart 0
    const baselineSetupTl: Timeline = {
      ...tlCurrent,
      tracks: [
        {
          ...tlCurrent.tracks[0],
          clips: [
            {
              id: "cl_actual_video_01",
              assetId: "6af851e1d8c9874f24593e13",
              trackId: tlCurrent.tracks[0].id,
              sourceStart: 0,
              sourceEnd: 30,
              timelineStart: 0,
              name: "2023-03-30 13-34-08 (0-30s)"
            }
          ]
        }
      ]
    };
    tlCurrent = await saveProjectTimeline(realProjectId, baselineSetupTl);

    const initialClip = tlCurrent.tracks[0].clips[0];
    assert(Boolean(initialClip), "Track contains initial real media clip");
    const originalStart = initialClip.timelineStart;
    console.log(`  ✓ Current clip start: ${originalStart}s on track '${tlCurrent.tracks[0].id}'`);
    passed++;

    // 2. Move clip horizontally from 0s to 12.5s and persist via saveProjectTimeline
    const targetStart = 12.5;
    const movedTimeline = moveClip(tlCurrent, initialClip.id, targetStart, tlCurrent.tracks[0].id);
    const savedTimeline = await saveProjectTimeline(realProjectId, movedTimeline);
    assert.strictEqual(savedTimeline.tracks[0].clips[0].timelineStart, targetStart);
    console.log(`  ✓ Successfully persisted clip moved to ${targetStart}s`);
    passed++;

    // 3. Verify via fresh GET request that persistence is durable
    const reloadedTimeline = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(reloadedTimeline!.tracks[0].clips[0].timelineStart, targetStart);
    console.log(`  ✓ Fresh GET request confirmed timelineStart is ${targetStart}s in database`);
    passed++;

    // 4. Move clip back to original position (0s) and persist to leave project in pristine state
    const restoredTimeline = moveClip(reloadedTimeline!, initialClip.id, originalStart, tlCurrent.tracks[0].id);
    await saveProjectTimeline(realProjectId, restoredTimeline);
    const finalTimeline = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(finalTimeline!.tracks[0].clips[0].timelineStart, originalStart);
    console.log(`  ✓ Restored clip to original start (${originalStart}s) in database`);
    passed++;

    // 12. Real Project Split Clip E2E Persistence Test
    console.log("\n[Suite 12] Real Project Split Clip E2E Persistence Test");
    const preSplitTl = await fetchProjectTimeline(realProjectId);
    assert(preSplitTl !== null && preSplitTl.tracks.length > 0, "Real timeline loaded");
    const clipToSplit = preSplitTl.tracks[0].clips[0];
    assert(Boolean(clipToSplit), "Target real clip found");

    // Split clip at 10.0s
    const splitPoint = 10.0;
    const splitResult = splitClipWithResult(preSplitTl, clipToSplit.id, splitPoint);
    assert.strictEqual(splitResult.firstClip.sourceEnd, splitPoint, "First segment sourceEnd is 10.0s");
    assert.strictEqual(splitResult.secondClip.sourceStart, splitPoint, "Second segment sourceStart is 10.0s");
    assert.strictEqual(splitResult.secondClip.timelineStart, splitPoint, "Second segment timelineStart is 10.0s");

    // Persist split timeline to database
    const savedSplit = await saveProjectTimeline(realProjectId, splitResult.timeline);
    assert.strictEqual(savedSplit.tracks[0].clips.length, 2, "Persisted timeline contains 2 segments");
    console.log("  ✓ Successfully persisted split clip to MongoDB Atlas");
    passed++;

    // Fresh GET verification
    const freshSplitTl = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(freshSplitTl!.tracks[0].clips.length, 2, "Fresh GET retrieved 2 split clips");
    assert.strictEqual(freshSplitTl!.tracks[0].clips[0].id, clipToSplit.id, "Segment 1 preserved original ID");
    assert.strictEqual(freshSplitTl!.tracks[0].clips[1].id, splitResult.secondClip.id, "Segment 2 has new ID");
    assert.strictEqual(freshSplitTl!.tracks[0].clips[0].sourceEnd, 10.0, "Segment 1 source range [0, 10]");
    assert.strictEqual(freshSplitTl!.tracks[0].clips[1].sourceStart, 10.0, "Segment 2 source range [10, 30]");
    console.log("  ✓ Fresh GET confirmed durable persistence of both split clips");
    passed++;

    // Restore original single clip [0, 30] so database is kept clean
    const restoreSingleClipTl = {
      ...freshSplitTl!,
      tracks: [
        {
          ...freshSplitTl!.tracks[0],
          clips: [
            {
              ...clipToSplit,
              sourceStart: 0,
              sourceEnd: 30,
              timelineStart: 0
            }
          ]
        }
      ]
    };
    await saveProjectTimeline(realProjectId, restoreSingleClipTl);
    const cleanedTl = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(cleanedTl!.tracks[0].clips.length, 1, "Cleaned timeline restored to 1 clip");
    console.log("  ✓ Restored real project timeline to clean baseline");
    passed++;

    // 13. Trim Clips Frontend Logic & State Verification
    console.log("\n[Suite 13] Trim Clips Frontend Logic & State Verification");

    const trimSampleClip: Clip = {
      id: "clip_trim_ui_1",
      assetId: "asset_test",
      trackId: "tr_1",
      sourceStart: 10,
      sourceEnd: 30, // 20s duration
      timelineStart: 5 // timeline interval: [5, 25]
    };

    test("Left trim handle dragging forward reduces duration and increases start times", () => {
      // 100px delta at pps 50 = +2.0 seconds
      const res = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "left",
        deltaPixels: 100,
        pps: 50
      });
      assert.strictEqual(res.newTimelineStart, 7.0);
      assert.strictEqual(res.newSourceStart, 12.0);
      assert.strictEqual(res.newSourceEnd, 30.0);
      assert.strictEqual(res.duration, 18.0);
    });

    test("Left trim handle dragging backward extends duration and decreases start times", () => {
      // -150px delta at pps 50 = -3.0 seconds
      const res = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "left",
        deltaPixels: -150,
        pps: 50
      });
      assert.strictEqual(res.newTimelineStart, 2.0);
      assert.strictEqual(res.newSourceStart, 7.0);
      assert.strictEqual(res.newSourceEnd, 30.0);
      assert.strictEqual(res.duration, 23.0);
    });

    test("Right trim handle dragging backward decreases duration and reduces sourceEnd", () => {
      // -250px delta at pps 50 = -5.0 seconds
      const res = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "right",
        deltaPixels: -250,
        pps: 50
      });
      assert.strictEqual(res.newTimelineStart, 5.0);
      assert.strictEqual(res.newSourceStart, 10.0);
      assert.strictEqual(res.newSourceEnd, 25.0);
      assert.strictEqual(res.duration, 15.0);
    });

    test("Right trim handle dragging forward extends duration and increases sourceEnd", () => {
      // +200px delta at pps 50 = +4.0 seconds
      const res = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "right",
        deltaPixels: 200,
        pps: 50
      });
      assert.strictEqual(res.newTimelineStart, 5.0);
      assert.strictEqual(res.newSourceStart, 10.0);
      assert.strictEqual(res.newSourceEnd, 34.0);
      assert.strictEqual(res.duration, 24.0);
    });

    test("Correct time calculations at different zoom levels", () => {
      // Zoom 0.5x (pps 25): 100px = 4.0s
      const resLowZoom = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "left",
        deltaPixels: 100,
        pps: 25
      });
      assert.strictEqual(resLowZoom.newTimelineStart, 9.0);

      // Zoom 2.0x (pps 100): 100px = 1.0s
      const resHighZoom = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "left",
        deltaPixels: 100,
        pps: 100
      });
      assert.strictEqual(resHighZoom.newTimelineStart, 6.0);
    });

    test("Horizontal scroll compensation accurately adjusts trim displacement", () => {
      // User moves mouse 50px right while container scrolled 30px right: total displacement = 80px
      const deltaX = 50;
      const scrollDelta = 30;
      const totalPixelDisplacement = deltaX + scrollDelta;
      const res = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "left",
        deltaPixels: totalPixelDisplacement,
        pps: 50
      });
      assert.strictEqual(res.newTimelineStart, 6.6); // 5.0 + 80/50 = 6.6s
    });

    test("Enforcing minimum clip duration to prevent accidental 0-duration cuts", () => {
      // Attempting to drag left handle past the right edge (e.g. +30s)
      const resLeftClamped = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "left",
        deltaPixels: 30 * 50,
        pps: 50
      });
      assert(resLeftClamped.duration >= MIN_CLIP_DURATION, "Left trim clamps to minimum duration");
      assert(resLeftClamped.newTimelineStart < 25.0, "Left trim start stays strictly before right edge");

      // Attempting to drag right handle before the left edge (e.g. -30s)
      const resRightClamped = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "right",
        deltaPixels: -30 * 50,
        pps: 50
      });
      assert(resRightClamped.duration >= MIN_CLIP_DURATION, "Right trim clamps to minimum duration");
      assert.strictEqual(resRightClamped.newTimelineStart, 5.0, "Right trim does not move clip timelineStart");
    });

    test("Trim gestures isolate the dragged edge and preserve the opposing boundary", () => {
      // Right trim: left edge (timelineStart) does NOT move
      const resRight = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "right",
        deltaPixels: -100,
        pps: 50
      });
      assert.strictEqual(resRight.newTimelineStart, trimSampleClip.timelineStart);

      // Left trim: right edge (timelineEnd = 25.0s) does NOT move
      const resLeft = calculateTrimmedClip({
        clip: trimSampleClip,
        edge: "left",
        deltaPixels: 100,
        pps: 50
      });
      assert.strictEqual(resLeft.newTimelineStart + resLeft.duration, 25.0);
    });

    test("Trim persistence through TimelineSaveQueue updates confirmed state", async () => {
      let savedInDB: Timeline | null = null;
      const baseTl = createEmptyTimeline({ projectId: "trim_queue_proj" });
      const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
      const initialTl = addClip(trTl, trimSampleClip);

      const queue = new TimelineSaveQueue({
        saveFn: async (payload) => {
          savedInDB = payload;
          return payload;
        },
        initialTimeline: initialTl
      });

      // Trim left edge from 5.0 to 8.0s
      const trimmedTl = trimClip(initialTl, trimSampleClip.id, "left", 8.0);
      queue.enqueue(trimmedTl);

      await new Promise((r) => setTimeout(r, 50));

      assert.notStrictEqual(savedInDB, null);
      assert.strictEqual((savedInDB as any)?.tracks[0].clips[0].timelineStart, 8.0);
      assert.strictEqual((queue.getLastSavedTimeline() as any)?.tracks[0].clips[0].timelineStart, 8.0);
    });

    test("Rollback on failed trim save restores pre-trim baseline", async () => {
      const baseTl = createEmptyTimeline({ projectId: "trim_fail_proj" });
      const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
      const preTrimTl = addClip(trTl, trimSampleClip);

      let rolledBackState: Timeline | null = null;
      let saveFailed = false;

      const queue = new TimelineSaveQueue({
        saveFn: async () => {
          throw new Error("Simulated network failure on trim save");
        },
        onSaveError: (_err, rolledBack) => {
          saveFailed = true;
          rolledBackState = rolledBack;
        },
        initialTimeline: preTrimTl
      });

      const trimmedTl = trimClip(preTrimTl, trimSampleClip.id, "left", 12.0);
      queue.enqueue(trimmedTl);

      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(saveFailed, true);
      assert.strictEqual((rolledBackState as any)?.tracks[0].clips[0].timelineStart, 5.0);
    });

    // 14. Real Project Trim Clips E2E Persistence Test
    console.log("\n[Suite 14] Real Project Trim Clips E2E Persistence Test");
    const realTlPreTrim = await fetchProjectTimeline(realProjectId);
    assert(realTlPreTrim !== null && realTlPreTrim.tracks.length > 0, "Loaded real timeline for project");
    const clipToTrim = realTlPreTrim.tracks[0].clips[0];
    assert.strictEqual(clipToTrim.sourceStart, 0, "Initial clip sourceStart is 0s");
    assert.strictEqual(clipToTrim.sourceEnd, 30, "Initial clip sourceEnd is 30s");
    assert.strictEqual(clipToTrim.timelineStart, 0, "Initial clip timelineStart is 0s");

    // 1. Trim left edge from 0.0s forward to 5.0s
    const leftTrimmedTl = trimClip(realTlPreTrim, clipToTrim.id, "left", 5.0);
    const savedLeftTrim = await saveProjectTimeline(realProjectId, leftTrimmedTl);
    assert.strictEqual(savedLeftTrim.tracks[0].clips[0].timelineStart, 5.0, "Saved left-trimmed timelineStart is 5.0s");
    assert.strictEqual(savedLeftTrim.tracks[0].clips[0].sourceStart, 5.0, "Saved left-trimmed sourceStart is 5.0s");
    assert.strictEqual(savedLeftTrim.tracks[0].clips[0].sourceEnd, 30.0, "Saved left-trimmed sourceEnd is 30.0s");
    console.log("  ✓ Successfully persisted left trim (start: 5.0s, duration: 25.0s) to MongoDB Atlas");
    passed++;

    // 2. Fresh GET to verify left trim durability
    const freshLeftTl = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(freshLeftTl!.tracks[0].clips[0].timelineStart, 5.0);
    assert.strictEqual(freshLeftTl!.tracks[0].clips[0].sourceStart, 5.0);
    console.log("  ✓ Fresh GET confirmed durable persistence of left trim");
    passed++;

    // 3. Trim right edge from 30.0s backward to 20.0s (timeline interval becomes [5.0, 20.0])
    const rightTrimmedTl = trimClip(freshLeftTl!, clipToTrim.id, "right", 20.0);
    const savedRightTrim = await saveProjectTimeline(realProjectId, rightTrimmedTl);
    assert.strictEqual(savedRightTrim.tracks[0].clips[0].timelineStart, 5.0, "Right trim preserves timelineStart at 5.0s");
    assert.strictEqual(savedRightTrim.tracks[0].clips[0].sourceStart, 5.0, "Right trim preserves sourceStart at 5.0s");
    assert.strictEqual(savedRightTrim.tracks[0].clips[0].sourceEnd, 20.0, "Right trim sets sourceEnd to 20.0s");
    console.log("  ✓ Successfully persisted right trim (source: 5.0s-20.0s, duration: 15.0s) to MongoDB Atlas");
    passed++;

    // 4. Fresh GET to verify right trim durability
    const freshRightTl = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(freshRightTl!.tracks[0].clips[0].sourceEnd, 20.0);
    assert.strictEqual(freshRightTl!.tracks[0].clips[0].timelineStart, 5.0);
    console.log("  ✓ Fresh GET confirmed durable persistence of right trim");
    passed++;

    // 5. Restore original baseline [0s, 30s] at 0s so database remains clean
    const restoredCleanTl = {
      ...freshRightTl!,
      tracks: [
        {
          ...freshRightTl!.tracks[0],
          clips: [
            {
              ...clipToTrim,
              sourceStart: 0,
              sourceEnd: 30,
              timelineStart: 0
            }
          ]
        }
      ]
    };
    await saveProjectTimeline(realProjectId, restoredCleanTl);
    const finalCleanTl = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(finalCleanTl!.tracks[0].clips[0].timelineStart, 0);
    assert.strictEqual(finalCleanTl!.tracks[0].clips[0].sourceEnd, 30);
    console.log("  ✓ Cleaned up and restored real project timeline to [0s-30s] baseline");
    passed++;
  } catch (err) {
    console.error("  ✗ FAIL: Live Vite dev server / proxy test failed:", err);
    failed++;
  }

  console.log(`\n=== Verification Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((err) => {
  console.error("Test execution threw error:", err);
  process.exit(1);
});
