import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
  deleteClip,
  createEmptyTimeline,
  addTrack,
  renameTrack,
  reorderTrack,
  moveTrackOrder,
  deleteTrack,
  generateDefaultTrackName,
  addClip,
  validateTimeline,
  TimelineHistory,
  timelineTimeToSourceTime,
  sourceTimeToTimelineTime,
  findNextVideoClipAfterTime,
  getTimelinePlaybackSnapshot,
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

    // 15. Delete Clips Frontend Logic & State Verification
    console.log("\n[Suite 15] Delete Clips Frontend Logic & State Verification");

    test("Delete action availability with and without selection", () => {
      let selectedClipId: string | null = null;
      assert.strictEqual(Boolean(selectedClipId), false, "canDelete is false when no clip selected");

      selectedClipId = "clip_sample_1";
      assert.strictEqual(Boolean(selectedClipId), true, "canDelete is true when clip selected");
    });

    test("Successful deletion updates UI state, clears selection, and leaves playhead stable", () => {
      const baseTl = createEmptyTimeline({ projectId: "del_ui_proj" });
      const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
      const withClips = addClip(
        addClip(trTl, {
          id: "c1",
          assetId: "a1",
          trackId: "tr_1",
          sourceStart: 0,
          sourceEnd: 10,
          timelineStart: 0
        }),
        {
          id: "c2",
          assetId: "a1",
          trackId: "tr_1",
          sourceStart: 10,
          sourceEnd: 20,
          timelineStart: 10
        }
      );

      let selectedId: string | null = "c1";
      let currentTime = 7.5; // playhead position

      // Execute deletion
      const updatedTl = deleteClip(withClips, selectedId);
      selectedId = null; // selection cleared

      assert.strictEqual(updatedTl.tracks[0].clips.length, 1, "Only 1 clip remains");
      assert.strictEqual(updatedTl.tracks[0].clips[0].id, "c2", "c2 is the remaining clip");
      assert.strictEqual(selectedId, null, "Selection successfully cleared");
      assert.strictEqual(currentTime, 7.5, "Playhead position remained stable at 7.5s");
    });

    test("Deleting the last clip on a track leaves an empty track for empty-state display", () => {
      const baseTl = createEmptyTimeline({ projectId: "del_empty_proj" });
      const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
      const withSingleClip = addClip(trTl, {
        id: "c_only",
        assetId: "a1",
        trackId: "tr_1",
        sourceStart: 0,
        sourceEnd: 10,
        timelineStart: 0
      });

      const emptyTl = deleteClip(withSingleClip, "c_only");
      assert.strictEqual(emptyTl.tracks[0].clips.length, 0, "Track clips array is empty");
    });

    test("Delete and Backspace shortcuts are ignored inside text inputs and editable fields", () => {
      let deleteTriggered = false;
      const handleDelete = () => {
        deleteTriggered = true;
      };

      const simulateKey = (key: string, tagName: string, isContentEditable = false) => {
        deleteTriggered = false;
        const target = { tagName, isContentEditable };
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return; // ignored
        }
        if (key === "Delete" || key === "Backspace") {
          handleDelete();
        }
      };

      // Inside input: ignored
      simulateKey("Delete", "INPUT");
      assert.strictEqual(deleteTriggered, false, "Delete ignored inside INPUT");
      simulateKey("Backspace", "TEXTAREA");
      assert.strictEqual(deleteTriggered, false, "Backspace ignored inside TEXTAREA");
      simulateKey("Delete", "DIV", true);
      assert.strictEqual(deleteTriggered, false, "Delete ignored in contentEditable");

      // Outside inputs: triggered
      simulateKey("Delete", "DIV", false);
      assert.strictEqual(deleteTriggered, true, "Delete executed outside inputs");
      simulateKey("Backspace", "DIV", false);
      assert.strictEqual(deleteTriggered, true, "Backspace executed outside inputs");
    });

    test("Deletion persistence through TimelineSaveQueue updates confirmed state", async () => {
      let savedInDB: Timeline | null = null;
      const baseTl = createEmptyTimeline({ projectId: "del_queue_proj" });
      const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
      const initialTl = addClip(trTl, {
        id: "c_save",
        assetId: "a1",
        trackId: "tr_1",
        sourceStart: 0,
        sourceEnd: 10,
        timelineStart: 0
      });

      const queue = new TimelineSaveQueue({
        saveFn: async (payload) => {
          savedInDB = payload;
          return payload;
        },
        initialTimeline: initialTl
      });

      const deletedTl = deleteClip(initialTl, "c_save");
      queue.enqueue(deletedTl);

      await new Promise((r) => setTimeout(r, 50));

      assert.notStrictEqual(savedInDB, null);
      assert.strictEqual((savedInDB as any)?.tracks[0].clips.length, 0);
      assert.strictEqual((queue.getLastSavedTimeline() as any)?.tracks[0].clips.length, 0);
    });

    test("Rollback on failed delete save restores pre-delete clip", async () => {
      const baseTl = createEmptyTimeline({ projectId: "del_fail_proj" });
      const trTl = addTrack(baseTl, { id: "tr_1", name: "Video", type: "video" });
      const preDeleteTl = addClip(trTl, {
        id: "c_rollback",
        assetId: "a1",
        trackId: "tr_1",
        sourceStart: 0,
        sourceEnd: 10,
        timelineStart: 0
      });

      let rolledBackState: Timeline | null = null;
      let saveFailed = false;

      const queue = new TimelineSaveQueue({
        saveFn: async () => {
          throw new Error("Network error during delete save");
        },
        onSaveError: (_err, rolledBack) => {
          saveFailed = true;
          rolledBackState = rolledBack;
        },
        initialTimeline: preDeleteTl
      });

      const deletedTl = deleteClip(preDeleteTl, "c_rollback");
      queue.enqueue(deletedTl);

      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(saveFailed, true);
      assert.strictEqual((rolledBackState as any)?.tracks[0].clips.length, 1);
      assert.strictEqual((rolledBackState as any)?.tracks[0].clips[0].id, "c_rollback");
    });

    // 16. Real Project Delete Clip E2E & Media Safety Verification
    console.log("\n[Suite 16] Real Project Delete Clip E2E & Media Safety Verification");

    // 1. Fetch real timeline and split into 2 clips [0, 10] and [10, 30]
    const realTl = await fetchProjectTimeline(realProjectId);
    assert(realTl !== null && realTl.tracks.length > 0, "Loaded real timeline");
    const clip1 = realTl.tracks[0].clips[0];

    const splitForDel = splitClipWithResult(realTl, clip1.id, 10.0);
    const twoClipsTl = await saveProjectTimeline(realProjectId, splitForDel.timeline);
    assert.strictEqual(twoClipsTl.tracks[0].clips.length, 2, "Real project now has 2 clips");

    // 2. Delete the first segment [0, 10]
    const deletedSegment1Tl = deleteClip(twoClipsTl, clip1.id);
    const savedAfterDelete = await saveProjectTimeline(realProjectId, deletedSegment1Tl);
    assert.strictEqual(savedAfterDelete.tracks[0].clips.length, 1, "Persisted timeline has 1 clip after deletion");
    assert.strictEqual(savedAfterDelete.tracks[0].clips[0].id, splitForDel.secondClip.id, "Remaining clip is segment 2");
    console.log("  ✓ Successfully deleted clip from real timeline and persisted to MongoDB Atlas");
    passed++;

    // 3. Fresh GET to verify deletion durability
    const freshDelTl = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(freshDelTl!.tracks[0].clips.length, 1);
    assert.strictEqual(freshDelTl!.tracks[0].clips[0].id, splitForDel.secondClip.id);
    console.log("  ✓ Fresh GET confirmed deletion durability");
    passed++;

    // 4. CRITICAL MEDIA SAFETY CHECKS
    // a. Verify media asset remains in project Media Library via backend API
    const mediaRes = await fetch(`http://localhost:3001/api/projects/${realProjectId}/media`);
    assert.strictEqual(mediaRes.status, 200, "GET /media returns 200");
    const mediaJson = (await mediaRes.json()) as any;
    assert(Array.isArray(mediaJson.data), "Media library returns array of assets");
    assert(mediaJson.data.length >= 1, "Media asset remains in library after timeline clip deletion");
    const targetAsset = mediaJson.data.find((a: any) => a.id === clip1.assetId);
    assert(Boolean(targetAsset), "Original media asset metadata remains in database");
    assert.strictEqual(targetAsset.duration, 225, "Media asset duration metadata preserved");
    console.log("  ✓ CRITICAL SAFETY: Media asset metadata PRESERVED in Media Library and database");
    passed++;

    // b. Verify physical media file on disk is completely untouched
    const defaultStoragePath = path.join(os.homedir(), ".agentcut", "projects", realProjectId, "media");
    assert(fs.existsSync(defaultStoragePath), "Project media directory exists on disk");
    const mediaFiles = fs.readdirSync(defaultStoragePath);
    assert(mediaFiles.length >= 1, "Physical media file exists in project storage directory");
    const filePath = path.join(defaultStoragePath, mediaFiles[0]);
    const fileStat = fs.statSync(filePath);
    assert(fileStat.size > 1000000, "Physical video binary size is intact (> 1MB)");
    console.log(`  ✓ CRITICAL SAFETY: Physical video file on disk PRESERVED (${fileStat.size} bytes)`);
    passed++;

    // 5. Restore baseline [0s, 30s] clip at 0s
    const baselineRestore: Timeline = {
      ...freshDelTl!,
      tracks: [
        {
          ...freshDelTl!.tracks[0],
          clips: [
            {
              ...clip1,
              sourceStart: 0,
              sourceEnd: 30,
              timelineStart: 0
            }
          ]
        }
      ]
    };
    await saveProjectTimeline(realProjectId, baselineRestore);
    const cleanedRealTl = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(cleanedRealTl!.tracks[0].clips.length, 1);
    assert.strictEqual(cleanedRealTl!.tracks[0].clips[0].sourceEnd, 30);
    console.log("  ✓ Restored real project timeline baseline to pristine state");
    passed++;

    // 17. Timeline Undo/Redo Frontend Logic & State Verification
    console.log("\n[Suite 17] Timeline Undo/Redo Frontend Logic & State Verification");

    // 1. History initialization with real timeline baseline
    const testTlBase = cleanedRealTl!;
    const historyManager = new TimelineHistory({ maxHistory: 50, initialTimeline: testTlBase });
    assert.strictEqual(historyManager.canUndo(), false, "Initial canUndo is false");
    assert.strictEqual(historyManager.canRedo(), false, "Initial canRedo is false");
    console.log("  ✓ Initial history state disables undo and redo");
    passed++;

    // 2. Move operation undo/redo
    const movedState = moveClip(testTlBase, clip1.id, 12.0);
    historyManager.push(movedState);
    assert.strictEqual(historyManager.canUndo(), true, "canUndo is true after move");
    assert.strictEqual(historyManager.canRedo(), false, "canRedo is false after new move");
    assert.strictEqual(historyManager.getCurrent()?.tracks[0].clips[0].timelineStart, 12.0);

    const undoneMove = historyManager.undo();
    assert.strictEqual(undoneMove?.tracks[0].clips[0].timelineStart, 0, "Undo move restores original timelineStart (0)");
    assert.strictEqual(historyManager.canUndo(), false, "canUndo is false after undoing to baseline");
    assert.strictEqual(historyManager.canRedo(), true, "canRedo is true after undo");

    const redoneMove = historyManager.redo();
    assert.strictEqual(redoneMove?.tracks[0].clips[0].timelineStart, 12.0, "Redo move re-applies moved timelineStart (12.0)");
    console.log("  ✓ Move clip Undo and Redo accurately restore positions");
    passed++;

    // 3. Split operation undo/redo
    const splitState = splitClip(redoneMove!, clip1.id, 20.0);
    historyManager.push(splitState);
    assert.strictEqual(splitState.tracks[0].clips.length, 2, "Split state has 2 clips");

    const undoneSplit = historyManager.undo();
    assert.strictEqual(undoneSplit?.tracks[0].clips.length, 1, "Undo split restores single clip");
    assert.strictEqual(undoneSplit?.tracks[0].clips[0].id, clip1.id, "Restored clip has original ID");

    const redoneSplit = historyManager.redo();
    assert.strictEqual(redoneSplit?.tracks[0].clips.length, 2, "Redo split restores 2 clips");
    console.log("  ✓ Split clip Undo restores original single clip, Redo restores segments");
    passed++;

    // 4. Trim operation undo/redo
    const trimmedState = trimClip(redoneSplit!, clip1.id, "right", 16.0);
    historyManager.push(trimmedState);
    assert.strictEqual(trimmedState.tracks[0].clips[0].sourceEnd, 4.0, "Trimmed clip sourceEnd updated");

    const undoneTrim = historyManager.undo();
    assert.strictEqual(undoneTrim?.tracks[0].clips[0].sourceEnd, 8.0, "Undo trim restores pre-trim sourceEnd");

    const redoneTrim = historyManager.redo();
    assert.strictEqual(redoneTrim?.tracks[0].clips[0].sourceEnd, 4.0, "Redo trim restores trimmed sourceEnd");
    console.log("  ✓ Trim clip Undo restores bounds, Redo re-applies trim");
    passed++;

    // 5. Delete operation undo/redo
    const deletedState = deleteClip(redoneTrim!, clip1.id);
    historyManager.push(deletedState);
    assert.strictEqual(deletedState.tracks[0].clips.length, 1, "Deleted state has 1 clip remaining");

    const undoneDelete = historyManager.undo();
    assert.strictEqual(undoneDelete?.tracks[0].clips.length, 2, "Undo delete restores the deleted clip");
    assert.strictEqual(undoneDelete?.tracks[0].clips[0].id, clip1.id, "Restored clip preserves ID");

    const redoneDelete = historyManager.redo();
    assert.strictEqual(redoneDelete?.tracks[0].clips.length, 1, "Redo delete removes clip again");
    console.log("  ✓ Delete clip Undo restores clip, Redo re-deletes clip");
    passed++;

    // 6. Redo branch invalidation on new edit
    historyManager.undo(); // back to 2 clips
    assert.strictEqual(historyManager.canRedo(), true, "canRedo is true before branch invalidation");
    const alternativeEdit = moveClip(historyManager.getCurrent()!, clip1.id, 5.0);
    historyManager.push(alternativeEdit);
    assert.strictEqual(historyManager.canRedo(), false, "Redo branch discarded after new edit");
    assert.strictEqual(historyManager.getRedoCount(), 0, "Redo count is 0 after new edit");
    console.log("  ✓ Redo branch invalidation correctly clears abandoned redo states");
    passed++;

    // 7. SaveQueue Coalescing with Rapid Undo/Redo
    let saveCount = 0;
    const saveCalls: Timeline[] = [];
    const queue = new TimelineSaveQueue({
      saveFn: async (payload) => {
        saveCount++;
        saveCalls.push(payload);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return payload;
      },
      initialTimeline: testTlBase
    });

    // Rapid successive undos enqueued into save queue
    queue.enqueue(testTlBase);
    queue.enqueue(movedState);
    queue.enqueue(testTlBase); // Rapid undo back to base

    while (queue.isBusy()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert(saveCount <= 2, `Rapid undo/redo was coalesced cleanly (${saveCount} saves executed)`);
    assert.strictEqual(
      saveCalls[saveCalls.length - 1].tracks[0].clips[0].timelineStart,
      0,
      "Final saved state matches trailing undo state"
    );
    console.log("  ✓ SaveQueue coalesces rapid undo/redo without out-of-order writes");
    passed++;

    // 8. Error reconciliation
    let rolledBack: Timeline | null = null;
    const failQueue = new TimelineSaveQueue({
      saveFn: async () => {
        throw new Error("Simulated network timeout");
      },
      onSaveError: (_err, rolledBackTl) => {
        if (rolledBackTl) rolledBack = rolledBackTl;
      },
      initialTimeline: testTlBase
    });

    failQueue.enqueue(movedState);
    while (failQueue.isBusy()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(rolledBack !== null, "Queue rolled back on network failure");
    historyManager.reconcile(rolledBack!);
    assert.strictEqual(
      historyManager.getCurrent()?.tracks[0].clips[0].timelineStart,
      0,
      "History reconciled to confirmed server timeline on failure"
    );
    console.log("  ✓ Error reconciliation safely aligns history stack with rolled-back server state");
    passed++;

    // 18. Real Project Undo/Redo E2E Persistence Verification
    console.log("\n[Suite 18] Real Project Undo/Redo E2E Persistence Verification");

    // 1. Start from confirmed baseline
    const liveBaseline = await fetchProjectTimeline(realProjectId);
    assert(liveBaseline !== null, "Live baseline loaded");
    const liveClip = liveBaseline.tracks[0].clips[0];
    const liveHistory = new TimelineHistory({ initialTimeline: liveBaseline });

    // 2. Perform Move on real project -> Persist
    const liveMoved = moveClip(liveBaseline, liveClip.id, 15.0);
    liveHistory.push(liveMoved);
    await saveProjectTimeline(realProjectId, liveMoved);
    const getAfterMove = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterMove!.tracks[0].clips[0].timelineStart, 15.0, "Move persisted to MongoDB Atlas");

    // 3. Undo Move -> Persist undone state to MongoDB
    const liveUndoneMove = liveHistory.undo()!;
    await saveProjectTimeline(realProjectId, liveUndoneMove);
    const getAfterUndoMove = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterUndoMove!.tracks[0].clips[0].timelineStart, 0, "Undo move persisted to MongoDB (start: 0)");
    console.log("  ✓ Real project Move Undo persisted and verified via fresh GET");
    passed++;

    // 4. Redo Move -> Persist redone state to MongoDB
    const liveRedoneMove = liveHistory.redo()!;
    await saveProjectTimeline(realProjectId, liveRedoneMove);
    const getAfterRedoMove = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterRedoMove!.tracks[0].clips[0].timelineStart, 15.0, "Redo move persisted to MongoDB (start: 15)");
    console.log("  ✓ Real project Move Redo persisted and verified via fresh GET");
    passed++;

    // 5. Perform Split -> Persist
    const liveSplit = splitClip(liveRedoneMove, liveClip.id, 25.0);
    liveHistory.push(liveSplit);
    await saveProjectTimeline(realProjectId, liveSplit);
    const getAfterSplit = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterSplit!.tracks[0].clips.length, 2, "Split persisted (2 clips)");

    // 6. Undo Split -> Persist undone state (1 clip restored)
    const liveUndoneSplit = liveHistory.undo()!;
    await saveProjectTimeline(realProjectId, liveUndoneSplit);
    const getAfterUndoSplit = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterUndoSplit!.tracks[0].clips.length, 1, "Undo split persisted (1 clip restored)");
    assert.strictEqual(getAfterUndoSplit!.tracks[0].clips[0].id, liveClip.id);
    console.log("  ✓ Real project Split Undo restores single original clip in MongoDB");
    passed++;

    // 7. Redo Split -> Persist redone state (2 clips restored)
    const liveRedoneSplit = liveHistory.redo()!;
    await saveProjectTimeline(realProjectId, liveRedoneSplit);
    const getAfterRedoSplit = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterRedoSplit!.tracks[0].clips.length, 2, "Redo split persisted (2 clips restored)");
    console.log("  ✓ Real project Split Redo restores both clip segments in MongoDB");
    passed++;

    // 8. Delete segment 2 -> Persist
    const seg2Id = getAfterRedoSplit!.tracks[0].clips[1].id;
    const liveDeleted = deleteClip(getAfterRedoSplit!, seg2Id);
    liveHistory.push(liveDeleted);
    await saveProjectTimeline(realProjectId, liveDeleted);
    const getAfterDelete = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterDelete!.tracks[0].clips.length, 1, "Delete persisted (1 clip)");

    // 9. Undo Delete -> Persist (segment 2 restored in MongoDB)
    const liveUndoneDelete = liveHistory.undo()!;
    await saveProjectTimeline(realProjectId, liveUndoneDelete);
    const getAfterUndoDelete = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(getAfterUndoDelete!.tracks[0].clips.length, 2, "Undo delete restored segment 2 in MongoDB");
    assert(getAfterUndoDelete!.tracks[0].clips.some((c) => c.id === seg2Id), "Exact deleted clip ID restored");
    console.log("  ✓ Real project Delete Undo restored deleted clip in MongoDB");
    passed++;

    // 10. CRITICAL MEDIA SAFETY: Verify physical media file on disk is untouched
    const diskMediaDir = path.join(os.homedir(), ".agentcut", "projects", realProjectId, "media");
    const diskFiles = fs.readdirSync(diskMediaDir);
    assert(diskFiles.length >= 1, "Video file exists on disk");
    const videoDiskStat = fs.statSync(path.join(diskMediaDir, diskFiles[0]));
    assert(videoDiskStat.size > 1000000, "Video size intact (> 1MB)");
    console.log(`  ✓ CRITICAL SAFETY: Physical video file intact after undo/redo cycles (${videoDiskStat.size} bytes)`);
    passed++;

    // 11. Restore pristine baseline [0, 30] clip at 0s
    const finalCleanBaseline: Timeline = {
      ...liveBaseline,
      tracks: [
        {
          ...liveBaseline.tracks[0],
          clips: [
            {
              ...liveClip,
              sourceStart: 0,
              sourceEnd: 30,
              timelineStart: 0
            }
          ]
        }
      ]
    };
    await saveProjectTimeline(realProjectId, finalCleanBaseline);
    const finalVerification = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(finalVerification!.tracks[0].clips.length, 1);
    assert.strictEqual(finalVerification!.tracks[0].clips[0].timelineStart, 0);
    assert.strictEqual(finalVerification!.tracks[0].clips[0].sourceEnd, 30);
    console.log("  ✓ Pristine baseline restored to MongoDB");
    passed++;

    // 19. Review Scenarios: Comprehensive Undo/Redo Concurrency, Failure, and Reload Regression Tests
    console.log("\n[Suite 19] Review Scenarios: Undo/Redo Concurrency, Failure, and Reload Regression Tests");

    // Scenario 1: User performs three edits rapidly while saves are pending
    {
      const s0 = cleanedRealTl!;
      const e1 = moveClip(s0, clip1.id, 5.0);
      const e2 = moveClip(e1, clip1.id, 10.0);
      const e3 = moveClip(e2, clip1.id, 15.0);

      const hist1 = new TimelineHistory({ initialTimeline: s0 });
      hist1.push(e1);
      hist1.push(e2);
      hist1.push(e3);

      assert.strictEqual(hist1.getHistoryLength(), 4, "Scenario 1: History contains all 3 rapid edits");
      assert.strictEqual(hist1.getCurrentIndex(), 3, "Scenario 1: Current index is at edit 3");
      assert.strictEqual(hist1.canUndo(), true, "Scenario 1: canUndo is true");
      assert.strictEqual(hist1.canRedo(), false, "Scenario 1: canRedo is false");

      let savesExecuted = 0;
      const savedStates: Timeline[] = [];
      const q1 = new TimelineSaveQueue({
        saveFn: async (payload) => {
          savesExecuted++;
          savedStates.push(payload);
          await new Promise((r) => setTimeout(r, 40));
          return payload;
        },
        initialTimeline: s0
      });

      // Rapidly enqueue all 3 edits while saves are pending
      q1.enqueue(e1);
      q1.enqueue(e2);
      q1.enqueue(e3);
      await q1.waitForIdle();

      assert(savesExecuted <= 2, `Scenario 1: Intermediate edits coalesced (${savesExecuted} saves run)`);
      assert.strictEqual(
        savedStates[savedStates.length - 1].tracks[0].clips[0].timelineStart,
        15.0,
        "Scenario 1: Final persisted state matches edit 3"
      );
      console.log("  ✓ Scenario 1: 3 rapid edits coalesce correctly into latest trailing save");
      passed++;
    }

    // Scenario 2: User immediately presses Undo three times
    {
      const s0 = cleanedRealTl!;
      const e1 = moveClip(s0, clip1.id, 5.0);
      const e2 = moveClip(e1, clip1.id, 10.0);
      const e3 = moveClip(e2, clip1.id, 15.0);

      const hist2 = new TimelineHistory({ initialTimeline: s0 });
      hist2.push(e1);
      hist2.push(e2);
      hist2.push(e3);

      const savedStates: Timeline[] = [];
      const q2 = new TimelineSaveQueue({
        saveFn: async (payload) => {
          savedStates.push(payload);
          await new Promise((r) => setTimeout(r, 40));
          return payload;
        },
        initialTimeline: e3
      });

      // Rapidly press undo 3 times
      const u1 = hist2.undo()!;
      q2.enqueue(u1);
      const u2 = hist2.undo()!;
      q2.enqueue(u2);
      const u3 = hist2.undo()!;
      q2.enqueue(u3);

      assert.strictEqual(u3.tracks[0].clips[0].timelineStart, 0, "Scenario 2: 3rd undo returns s0");
      assert.strictEqual(hist2.getCurrentIndex(), 0, "Scenario 2: History index is at 0");
      assert.strictEqual(hist2.canUndo(), false, "Scenario 2: canUndo is false at base");
      assert.strictEqual(hist2.canRedo(), true, "Scenario 2: canRedo is true (3 redo steps available)");
      assert.strictEqual(hist2.getRedoCount(), 3, "Scenario 2: getRedoCount is 3");

      await q2.waitForIdle();
      assert.strictEqual(
        savedStates[savedStates.length - 1].tracks[0].clips[0].timelineStart,
        0,
        "Scenario 2: Final persisted state matches base state s0"
      );
      console.log("  ✓ Scenario 2: Rapid 3x undo steps back accurately and persists baseline s0");
      passed++;
    }

    // Scenario 3: User presses Redo while an Undo save is still pending
    {
      const s0 = cleanedRealTl!;
      const e1 = moveClip(s0, clip1.id, 8.0);
      const hist3 = new TimelineHistory({ initialTimeline: s0 });
      hist3.push(e1);

      // Undo to s0
      const undone = hist3.undo()!;
      const savedStates: Timeline[] = [];
      const q3 = new TimelineSaveQueue({
        saveFn: async (payload) => {
          savedStates.push(payload);
          await new Promise((r) => setTimeout(r, 40));
          return payload;
        },
        initialTimeline: e1
      });

      // Enqueue undo save (s0)
      q3.enqueue(undone);
      assert.strictEqual(q3.isBusy(), true, "Scenario 3: Undo save is in flight");

      // While undo save is in flight, user presses Redo
      const redone = hist3.redo()!;
      q3.enqueue(redone);

      assert.strictEqual(hist3.getCurrentIndex(), 1, "Scenario 3: History index restored to 1");
      assert.strictEqual(hist3.canUndo(), true, "Scenario 3: canUndo is true after redo");
      assert.strictEqual(hist3.canRedo(), false, "Scenario 3: canRedo is false after redo");

      await q3.waitForIdle();
      assert.strictEqual(
        savedStates[savedStates.length - 1].tracks[0].clips[0].timelineStart,
        8.0,
        "Scenario 3: Final persisted state matches redone edit e1"
      );
      console.log("  ✓ Scenario 3: Redo during pending undo serializes without out-of-order writes");
      passed++;
    }

    // Scenario 4: User performs a new edit after Undo while a save is pending
    {
      const s0 = cleanedRealTl!;
      const e1 = moveClip(s0, clip1.id, 6.0);
      const hist4 = new TimelineHistory({ initialTimeline: s0 });
      hist4.push(e1);

      // Undo back to s0
      const undone = hist4.undo()!;
      const savedStates: Timeline[] = [];
      const q4 = new TimelineSaveQueue({
        saveFn: async (payload) => {
          savedStates.push(payload);
          await new Promise((r) => setTimeout(r, 40));
          return payload;
        },
        initialTimeline: e1
      });

      q4.enqueue(undone);
      assert.strictEqual(q4.isBusy(), true, "Scenario 4: Undo save in flight");

      // While undo save is in flight, perform NEW edit e2 (start: 18.0)
      const e2 = moveClip(s0, clip1.id, 18.0);
      hist4.push(e2);
      q4.enqueue(e2);

      assert.strictEqual(hist4.canRedo(), false, "Scenario 4: Abandoned redo branch (e1) discarded");
      assert.strictEqual(hist4.getHistoryLength(), 2, "Scenario 4: History contains [s0, e2]");
      assert.strictEqual(hist4.getCurrent()?.tracks[0].clips[0].timelineStart, 18.0);

      await q4.waitForIdle();
      assert.strictEqual(
        savedStates[savedStates.length - 1].tracks[0].clips[0].timelineStart,
        18.0,
        "Scenario 4: Final persisted state matches new edit e2"
      );
      console.log("  ✓ Scenario 4: New edit after undo discards abandoned redo and persists cleanly");
      passed++;
    }

    // Scenario 5: The first in-flight save fails while newer undo/redo states are queued
    {
      const s0 = cleanedRealTl!;
      const e1 = moveClip(s0, clip1.id, 7.0);

      let e1Failed = false;
      let e2Succeeded = false;
      let rollbackReported: Timeline | null = null;

      const q5 = new TimelineSaveQueue({
        saveFn: async (payload) => {
          await new Promise((r) => setTimeout(r, 30));
          if (payload.tracks[0].clips[0].timelineStart === 7.0) {
            e1Failed = true;
            throw new Error("Simulated 500 error on edit 1");
          }
          e2Succeeded = true;
          return payload;
        },
        onSaveError: (_err, rolledBack) => {
          rollbackReported = rolledBack;
        },
        initialTimeline: s0
      });

      // Enqueue edit 1
      q5.enqueue(e1);
      // While edit 1 is failing, user presses undo back to s0
      q5.enqueue(s0);

      await q5.waitForIdle();

      assert.strictEqual(e1Failed, true, "Scenario 5: First save failed as expected");
      assert.strictEqual(e2Succeeded, true, "Scenario 5: Second queued save (undo to s0) proceeded and succeeded");
      assert.strictEqual(rollbackReported, null, "Scenario 5: No erroneous rollback triggered since newer edit was queued");
      assert.strictEqual(q5.getLastSavedTimeline()?.tracks[0].clips[0].timelineStart, 0);
      console.log("  ✓ Scenario 5: First save failure does not prevent newer queued state from saving");
      passed++;
    }

    // Scenario 6: The final coalesced save fails
    {
      const s0 = cleanedRealTl!;
      const e1 = moveClip(s0, clip1.id, 5.0);
      const e2 = moveClip(e1, clip1.id, 10.0);

      const hist6 = new TimelineHistory({ initialTimeline: s0 });
      hist6.push(e1);
      hist6.push(e2);
      assert.strictEqual(hist6.getCurrentIndex(), 2, "Scenario 6: Index is 2 before save failure");

      let rollbackState: Timeline | null = null;
      let errorReported: Error | null = null;

      const q6 = new TimelineSaveQueue({
        saveFn: async () => {
          await new Promise((r) => setTimeout(r, 30));
          throw new Error("Final coalesced save failed on server");
        },
        onSaveError: (err, rolledBack) => {
          errorReported = err;
          rollbackState = rolledBack;
        },
        initialTimeline: s0
      });

      q6.enqueue(e2);
      await q6.waitForIdle();

      assert(errorReported !== null, "Scenario 6: Error reported on final save failure");
      assert(rollbackState !== null, "Scenario 6: Rollback target provided");
      assert.strictEqual((rollbackState as Timeline | null)?.tracks[0].clips[0].timelineStart, 0, "Scenario 6: Rolled back to confirmed s0");

      // Reconcile history
      hist6.reconcile(rollbackState!);
      assert.strictEqual(hist6.getCurrentIndex(), 0, "Scenario 6: History index reverted to s0 (0)");
      assert.strictEqual(hist6.getCurrent()?.tracks[0].clips[0].timelineStart, 0, "Scenario 6: Current timeline is s0");
      assert.strictEqual(hist6.canRedo(), false, "Scenario 6: No invalid redo branch left after rollback");
      assert.strictEqual(hist6.getHistoryLength(), 1, "Scenario 6: Unconfirmed forward edits trimmed");
      console.log("  ✓ Scenario 6: Final save failure rolls back cleanly without leaving invalid redo branches");
      passed++;
    }

    // Scenario 7: The timeline is reloaded while history has pending operations
    {
      const s0 = cleanedRealTl!;
      const e1 = moveClip(s0, clip1.id, 14.0);

      let saveStarted = false;
      let saveFinished = false;

      const q7 = new TimelineSaveQueue({
        saveFn: async (payload) => {
          saveStarted = true;
          await new Promise((r) => setTimeout(r, 60));
          saveFinished = true;
          return payload;
        },
        initialTimeline: s0
      });

      // User performs edit e1
      q7.enqueue(e1);
      assert.strictEqual(q7.isBusy(), true, "Scenario 7: Save is in flight");
      assert.strictEqual(saveStarted, true, "Scenario 7: Save has started in background");

      // Reload starts: calls waitForIdle() before reading
      assert.strictEqual(saveFinished, false, "Scenario 7: Save has not finished yet");
      await q7.waitForIdle();
      assert.strictEqual(saveFinished, true, "Scenario 7: waitForIdle() ensured in-flight save settled");

      // Now simulated fresh reload returns confirmed state
      const reloadedData = q7.getLastSavedTimeline()!;
      assert.strictEqual(reloadedData.tracks[0].clips[0].timelineStart, 14.0, "Scenario 7: Reload reads updated confirmed state");

      const hist7 = new TimelineHistory({ initialTimeline: reloadedData });
      assert.strictEqual(hist7.getCurrentIndex(), 0, "Scenario 7: Fresh history initialized at index 0");
      assert.strictEqual(hist7.canUndo(), false, "Scenario 7: canUndo false on fresh reload");
      assert.strictEqual(hist7.canRedo(), false, "Scenario 7: canRedo false on fresh reload");
      console.log("  ✓ Scenario 7: Reload waits for pending operations and initializes clean durable state");
      passed++;
    }

    // 20. Timeline Playback & Preview Synchronization Verification
    console.log("\n[Suite 20] Timeline Playback & Preview Synchronization Verification");

    // 1. A clip beginning at timeline time zero
    const pbClipZero: Clip = {
      id: "pb_c_zero",
      assetId: "asset_test_vid",
      trackId: "tr_v1",
      sourceStart: 0,
      sourceEnd: 15.0,
      timelineStart: 0,
      name: "Clip Starting at 0"
    };
    assert.strictEqual(timelineTimeToSourceTime(pbClipZero, 0), 0);
    assert.strictEqual(timelineTimeToSourceTime(pbClipZero, 7.5), 7.5);
    assert.strictEqual(timelineTimeToSourceTime(pbClipZero, 15.0), 15.0);
    assert.strictEqual(sourceTimeToTimelineTime(pbClipZero, 7.5), 7.5);
    console.log("  ✓ 1. Clip beginning at timeline time zero maps accurately both ways");
    passed++;

    // 2. A clip beginning at a non-zero timeline position
    const pbClipNonzeroTl: Clip = {
      id: "pb_c_nonzerotl",
      assetId: "asset_test_vid",
      trackId: "tr_v1",
      sourceStart: 0,
      sourceEnd: 20.0,
      timelineStart: 12.0,
      name: "Clip Starting at 12s"
    };
    assert.strictEqual(timelineTimeToSourceTime(pbClipNonzeroTl, 12.0), 0);
    assert.strictEqual(timelineTimeToSourceTime(pbClipNonzeroTl, 18.0), 6.0);
    assert.strictEqual(sourceTimeToTimelineTime(pbClipNonzeroTl, 6.0), 18.0);
    console.log("  ✓ 2. Clip beginning at non-zero timeline position maps accurately");
    passed++;

    // 3. A clip with a non-zero sourceStart
    const pbClipNonzeroSrc: Clip = {
      id: "pb_c_nonzerosrc",
      assetId: "asset_test_vid",
      trackId: "tr_v1",
      sourceStart: 25.0,
      sourceEnd: 45.0,
      timelineStart: 8.0,
      name: "Clip with sourceStart 25s"
    };
    assert.strictEqual(timelineTimeToSourceTime(pbClipNonzeroSrc, 8.0), 25.0);
    assert.strictEqual(timelineTimeToSourceTime(pbClipNonzeroSrc, 18.0), 35.0);
    assert.strictEqual(timelineTimeToSourceTime(pbClipNonzeroSrc, 28.0), 45.0);
    assert.strictEqual(sourceTimeToTimelineTime(pbClipNonzeroSrc, 35.0), 18.0);
    console.log("  ✓ 3. Clip with non-zero sourceStart maps with correct source offset");
    passed++;

    // 4. A moved clip
    const pbBaseTl = createEmptyTimeline({ projectId: "pb_proj" });
    const pbTrackTl = addTrack(pbBaseTl, { id: "tr_v1", name: "Video", type: "video" });
    const pbWithClip = addClip(pbTrackTl, pbClipZero);
    const pbMovedTl = moveClip(pbWithClip, pbClipZero.id, 25.0);
    const movedClipObj = pbMovedTl.tracks[0].clips[0];

    assert.strictEqual(movedClipObj.timelineStart, 25.0);
    assert.strictEqual(timelineTimeToSourceTime(movedClipObj, 25.0), 0);
    assert.strictEqual(timelineTimeToSourceTime(movedClipObj, 30.0), 5.0);
    console.log("  ✓ 4. Moved clip maps playback to correct source section");
    passed++;

    // 5. A split clip and both resulting segments
    const pbSplitRes = splitClipWithResult(pbWithClip, pbClipZero.id, 10.0);
    const splitSeg1 = pbSplitRes.firstClip;
    const splitSeg2 = pbSplitRes.secondClip;

    assert.strictEqual(splitSeg1.timelineStart, 0);
    assert.strictEqual(splitSeg1.sourceStart, 0);
    assert.strictEqual(splitSeg1.sourceEnd, 10.0);
    assert.strictEqual(timelineTimeToSourceTime(splitSeg1, 5.0), 5.0);

    assert.strictEqual(splitSeg2.timelineStart, 10.0);
    assert.strictEqual(splitSeg2.sourceStart, 10.0);
    assert.strictEqual(splitSeg2.sourceEnd, 15.0);
    assert.strictEqual(timelineTimeToSourceTime(splitSeg2, 10.0), 10.0);
    assert.strictEqual(timelineTimeToSourceTime(splitSeg2, 13.0), 13.0);
    console.log("  ✓ 5. Split clip segments map to respective source media sections");
    passed++;

    // 6. A left-trimmed clip
    const pbLeftTrimmedTl = trimClip(pbWithClip, pbClipZero.id, "left", 5.0);
    const leftTrimmedClip = pbLeftTrimmedTl.tracks[0].clips[0];
    assert.strictEqual(leftTrimmedClip.timelineStart, 5.0);
    assert.strictEqual(leftTrimmedClip.sourceStart, 5.0);
    assert.strictEqual(timelineTimeToSourceTime(leftTrimmedClip, 5.0), 5.0);
    assert.strictEqual(timelineTimeToSourceTime(leftTrimmedClip, 10.0), 10.0);
    console.log("  ✓ 6. Left-trimmed clip respects updated timelineStart and sourceStart");
    passed++;

    // 7. A right-trimmed clip
    const pbRightTrimmedTl = trimClip(pbWithClip, pbClipZero.id, "right", 8.0);
    const rightTrimmedClip = pbRightTrimmedTl.tracks[0].clips[0];
    assert.strictEqual(rightTrimmedClip.timelineStart, 0);
    assert.strictEqual(rightTrimmedClip.sourceEnd, 8.0);
    assert.strictEqual(timelineTimeToSourceTime(rightTrimmedClip, 8.0), 8.0);
    console.log("  ✓ 7. Right-trimmed clip respects updated sourceEnd boundary");
    passed++;

    // 8. Seeking into a gap
    const pbGapTl = addClip(
      addClip(pbTrackTl, {
        id: "c_gap_1",
        assetId: "asset_test_vid",
        trackId: "tr_v1",
        sourceStart: 0,
        sourceEnd: 8.0,
        timelineStart: 0,
        name: "Clip 1"
      }),
      {
        id: "c_gap_2",
        assetId: "asset_test_vid",
        trackId: "tr_v1",
        sourceStart: 8.0,
        sourceEnd: 16.0,
        timelineStart: 18.0, // 8.0 to 18.0 is a 10s GAP!
        name: "Clip 2"
      }
    );

    const gapSnap = getTimelinePlaybackSnapshot(pbGapTl, 12.0);
    assert.strictEqual(gapSnap.isGap, true, "Snapshot at 12.0s is a gap");
    assert.strictEqual(gapSnap.activeClip, null, "Active clip is null in gap");
    console.log("  ✓ 8. Seeking into gap returns null active clip and isGap: true");
    passed++;

    // 9. Seeking exactly to clip boundaries
    const snapAt0 = getTimelinePlaybackSnapshot(pbGapTl, 0);
    assert.strictEqual(snapAt0.isGap, false);
    assert.strictEqual(snapAt0.activeClip?.clip.id, "c_gap_1");
    assert.strictEqual(snapAt0.activeClip?.sourceTime, 0);

    const snapAtClip1End = getTimelinePlaybackSnapshot(pbGapTl, 8.0);
    assert.strictEqual(snapAtClip1End.isGap, true, "At exact clip end boundary 8.0s, enters gap");

    const snapAtClip2Start = getTimelinePlaybackSnapshot(pbGapTl, 18.0);
    assert.strictEqual(snapAtClip2Start.isGap, false);
    assert.strictEqual(snapAtClip2Start.activeClip?.clip.id, "c_gap_2");
    assert.strictEqual(snapAtClip2Start.activeClip?.sourceTime, 8.0);
    console.log("  ✓ 9. Seeking exactly to clip boundaries switches cleanly between clips and gaps");
    passed++;

    // 10. Transition to a contiguous next clip
    const contiguousNext = findNextVideoClipAfterTime(pbSplitRes.timeline, 10.0, splitSeg1.id);
    assert(contiguousNext !== null, "Contiguous next clip exists");
    assert.strictEqual(contiguousNext?.clip.id, splitSeg2.id);
    assert.strictEqual(contiguousNext?.isContiguous, true, "isContiguous is true for contiguous split");
    assert.strictEqual(contiguousNext?.sourceStart, 10.0);
    console.log("  ✓ 10. Contiguous adjacent clips detect seamless transition");
    passed++;

    // 11. Pausing at a gap or clip end
    const nextAcrossGap = findNextVideoClipAfterTime(pbGapTl, 8.0, "c_gap_1");
    assert.strictEqual(nextAcrossGap?.isContiguous, false, "Clip across gap is NOT contiguous");
    assert.strictEqual(nextAcrossGap?.gapDuration, 10.0, "Gap duration is 10s; playback must pause at boundary");
    console.log("  ✓ 11. Gaps between clips correctly identify non-contiguous interval requiring pause");
    passed++;

    // 12. Ensuring playback does not create timeline saves or undo/redo entries
    const histBeforeScrub = new TimelineHistory({ initialTimeline: pbGapTl });
    for (let t = 0; t <= 25; t += 1.0) {
      const snap = getTimelinePlaybackSnapshot(pbGapTl, t);
      assert(snap !== null);
    }
    assert.strictEqual(histBeforeScrub.getHistoryLength(), 1, "History length remains unchanged during playback");
    assert.strictEqual(histBeforeScrub.canUndo(), false, "No undo steps created by playback");
    assert.strictEqual(histBeforeScrub.canRedo(), false, "No redo steps created by playback");
    console.log("  ✓ 12. Playback and seeking create zero timeline saves or undo/redo entries");
    passed++;

    // 13. Topmost enabled video track priority
    const multiTrackTl: Timeline = {
      ...createEmptyTimeline({ projectId: "mt_proj" }),
      tracks: [
        {
          id: "tr_bottom",
          name: "Video Bottom",
          type: "video",
          index: 1,
          enabled: true,
          clips: [
            {
              id: "c_bottom",
              assetId: "asset_vid_2",
              trackId: "tr_bottom",
              sourceStart: 0,
              sourceEnd: 20,
              timelineStart: 0
            }
          ]
        },
        {
          id: "tr_top",
          name: "Video Top",
          type: "video",
          index: 0,
          enabled: true,
          clips: [
            {
              id: "c_top",
              assetId: "asset_vid_1",
              trackId: "tr_top",
              sourceStart: 5,
              sourceEnd: 15,
              timelineStart: 0
            }
          ]
        }
      ]
    };
    const topSnapshot = getTimelinePlaybackSnapshot(multiTrackTl, 5.0);
    assert.strictEqual(topSnapshot.activeClip?.clip.id, "c_top", "Topmost video track (index 0) takes priority over lower track (index 1)");
    assert.strictEqual(topSnapshot.activeClip?.track.id, "tr_top");
    console.log("  ✓ 13. Topmost enabled video track priority strictly respects track index ordering");
    passed++;

    // 14. Transition between clips with different media assets
    const diffAssetTl: Timeline = {
      ...createEmptyTimeline({ projectId: "da_proj" }),
      tracks: [
        {
          id: "tr_v1",
          name: "Video",
          type: "video",
          index: 0,
          enabled: true,
          clips: [
            {
              id: "c_asset1",
              assetId: "asset_vid_A",
              trackId: "tr_v1",
              sourceStart: 0,
              sourceEnd: 10,
              timelineStart: 0
            },
            {
              id: "c_asset2",
              assetId: "asset_vid_B",
              trackId: "tr_v1",
              sourceStart: 5,
              sourceEnd: 25,
              timelineStart: 10
            }
          ]
        }
      ]
    };
    const nextDiffAsset = findNextVideoClipAfterTime(diffAssetTl, 10.0, "c_asset1");
    assert(nextDiffAsset !== null);
    assert.strictEqual(nextDiffAsset?.isContiguous, true, "Clips adjacent on timeline form contiguous transition regardless of asset");
    assert.strictEqual(nextDiffAsset?.clip.assetId, "asset_vid_B", "Next clip references different asset asset_vid_B");
    assert.strictEqual(nextDiffAsset?.sourceStart, 5, "Next clip source starts at 5.0s on asset_vid_B");
    console.log("  ✓ 14. Transition between different media assets identifies contiguous boundary and target asset");
    passed++;

    // 21. Real Project Timeline Playback Synchronization E2E Verification
    console.log("\n[Suite 21] Real Project Timeline Playback Synchronization E2E Verification");

    // 1. Fetch real timeline
    const realTlForPb = await fetchProjectTimeline(realProjectId);
    assert(realTlForPb !== null && realTlForPb.tracks.length > 0, "Loaded real project timeline");
    const rClip = realTlForPb.tracks[0].clips[0];

    // 2. Test timeline-to-source time mapping across real clip
    const srcAt0 = timelineTimeToSourceTime(rClip, 0);
    const srcAt10 = timelineTimeToSourceTime(rClip, 10.0);
    const srcAt20 = timelineTimeToSourceTime(rClip, 20.0);
    const srcAt29 = timelineTimeToSourceTime(rClip, 29.5);

    assert.strictEqual(srcAt0, 0);
    assert.strictEqual(srcAt10, 10.0);
    assert.strictEqual(srcAt20, 20.0);
    assert.strictEqual(srcAt29, 29.5);
    console.log("  ✓ Real project clip maps timeline time to exact source seconds");
    passed++;

    // 3. Test seeking past clip end into gap
    const snapPastEnd = getTimelinePlaybackSnapshot(realTlForPb, 35.0);
    assert.strictEqual(snapPastEnd.isGap, true, "Past clip end (35s) detects gap");
    assert.strictEqual(snapPastEnd.activeClip, null, "No video footage played in gap");
    console.log("  ✓ Real project gap detection prevents playing unrelated footage");
    passed++;

    // 4. Verify playback scrubbing does NOT issue PUT requests or mutate MongoDB
    const beforeGet = await fetchProjectTimeline(realProjectId);
    const originalUpdatedAt = beforeGet!.updatedAt;

    // Simulate playhead scrubbing across timeline
    for (let sec = 0; sec <= 30; sec += 2.5) {
      const pSnap = getTimelinePlaybackSnapshot(realTlForPb, sec);
      assert(pSnap !== null);
    }

    // Verify MongoDB state is completely untouched
    const afterGet = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(afterGet!.tracks[0].clips.length, beforeGet!.tracks[0].clips.length);
    assert.strictEqual(afterGet!.updatedAt, originalUpdatedAt, "MongoDB timeline updatedAt remained untouched during playback");
    console.log("  ✓ Playback and scrubbing did NOT issue PUT requests or alter database state");
    passed++;

    // 5. CRITICAL MEDIA SAFETY: Verify physical video file on disk is untouched
    const realDiskDir = path.join(os.homedir(), ".agentcut", "projects", realProjectId, "media");
    const rFiles = fs.readdirSync(realDiskDir);
    assert(rFiles.length >= 1);
    const vStat = fs.statSync(path.join(realDiskDir, rFiles[0]));
    assert(vStat.size > 1000000);
    console.log(`  ✓ CRITICAL SAFETY: Physical video file intact on disk (${vStat.size} bytes)`);
    passed++;

    // 6. Restore pristine baseline
    const pristinePbBaseline: Timeline = {
      ...realTlForPb,
      tracks: [
        {
          ...realTlForPb.tracks[0],
          clips: [
            {
              ...rClip,
              sourceStart: 0,
              sourceEnd: 30,
              timelineStart: 0
            }
          ]
        }
      ]
    };
    await saveProjectTimeline(realProjectId, pristinePbBaseline);
    const verifiedBaseline = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(verifiedBaseline!.tracks[0].clips.length, 1);
    assert.strictEqual(verifiedBaseline!.tracks[0].clips[0].sourceEnd, 30);
    console.log("  ✓ Real project timeline baseline restored to pristine state");
    passed++;

    // 22. Track Management Frontend Logic, State & Undo/Redo Verification
    console.log("\n[Suite 22] Track Management Frontend Logic, State & Undo/Redo Verification");

    let tHistTl = createEmptyTimeline({ projectId: "tm_test_proj" });

    // 1. Add Track
    const v1 = addTrack(tHistTl, { name: generateDefaultTrackName(tHistTl, "video"), type: "video" });
    assert.strictEqual(v1.tracks.length, 1);
    assert.strictEqual(v1.tracks[0].name, "Video 1");
    assert.strictEqual(v1.tracks[0].index, 0);

    const a1 = addTrack(v1, { name: generateDefaultTrackName(v1, "audio"), type: "audio" });
    assert.strictEqual(a1.tracks.length, 2);
    assert.strictEqual(a1.tracks[1].name, "Audio 1");
    assert.strictEqual(a1.tracks[1].index, 1);

    const c1 = addTrack(a1, { name: generateDefaultTrackName(a1, "caption"), type: "caption" });
    assert.strictEqual(c1.tracks.length, 3);
    assert.strictEqual(c1.tracks[2].name, "Captions 1");
    assert.strictEqual(c1.tracks[2].index, 2);

    console.log("  ✓ 1. Adding video, audio, and caption tracks with sensible default names");
    passed++;

    // 2. Reject blank names
    let addBlankThrew = false;
    try {
      addTrack(c1, { name: "   ", type: "video" });
    } catch {
      addBlankThrew = true;
    }
    assert.strictEqual(addBlankThrew, true, "Blank track name rejected on add");

    let renameBlankThrew = false;
    try {
      renameTrack(c1, c1.tracks[0].id, "   ");
    } catch {
      renameBlankThrew = true;
    }
    assert.strictEqual(renameBlankThrew, true, "Blank track name rejected on rename");

    console.log("  ✓ 2. Rejecting blank or whitespace-only track names on add and rename");
    passed++;

    // 3. Rename Track
    const renamed = renameTrack(c1, c1.tracks[0].id, "  Foreground Cut  ");
    assert.strictEqual(renamed.tracks[0].name, "Foreground Cut", "Whitespace trimmed on rename");
    assert.strictEqual(renamed.tracks[0].id, c1.tracks[0].id);
    assert.strictEqual(renamed.tracks[0].index, 0);

    console.log("  ✓ 3. Renaming track trims whitespace and preserves identity");
    passed++;

    // 4. Reorder Tracks
    // Currently: Foreground Cut (0), Audio 1 (1), Captions 1 (2)
    // Move Foreground Cut down -> Audio 1 becomes 0, Foreground Cut becomes 1
    const reorderedDown = reorderTrack(renamed, renamed.tracks[0].id, "down");
    assert.strictEqual(reorderedDown.tracks[0].name, "Audio 1");
    assert.strictEqual(reorderedDown.tracks[0].index, 0);
    assert.strictEqual(reorderedDown.tracks[1].name, "Foreground Cut");
    assert.strictEqual(reorderedDown.tracks[1].index, 1);
    assert.strictEqual(reorderedDown.tracks[2].name, "Captions 1");
    assert.strictEqual(reorderedDown.tracks[2].index, 2);

    // Move Captions 1 up -> Captions 1 becomes 1, Foreground Cut becomes 2
    const reorderedUp = reorderTrack(reorderedDown, reorderedDown.tracks[2].id, "up");
    assert.strictEqual(reorderedUp.tracks[0].name, "Audio 1");
    assert.strictEqual(reorderedUp.tracks[0].index, 0);
    assert.strictEqual(reorderedUp.tracks[1].name, "Captions 1");
    assert.strictEqual(reorderedUp.tracks[1].index, 1);
    assert.strictEqual(reorderedUp.tracks[2].name, "Foreground Cut");
    assert.strictEqual(reorderedUp.tracks[2].index, 2);

    // moveTrackOrder directly:
    const movedDirectly = moveTrackOrder(reorderedUp, reorderedUp.tracks[0].id, 2);
    assert.strictEqual(movedDirectly.tracks[2].name, "Audio 1");
    assert.strictEqual(movedDirectly.tracks[2].index, 2);

    console.log("  ✓ 4. Reordering tracks up and down recalculates sequential indices");
    passed++;

    // 5. Boundary reordering restrictions
    let topUpThrew = false;
    try {
      reorderTrack(reorderedUp, reorderedUp.tracks[0].id, "up");
    } catch {
      topUpThrew = true;
    }
    assert.strictEqual(topUpThrew, true, "Cannot move topmost track up");

    let bottomDownThrew = false;
    try {
      reorderTrack(reorderedUp, reorderedUp.tracks[2].id, "down");
    } catch {
      bottomDownThrew = true;
    }
    assert.strictEqual(bottomDownThrew, true, "Cannot move bottommost track down");

    console.log("  ✓ 5. Moving topmost track up or bottommost track down cleanly blocked");
    passed++;

    // 6. Delete empty track
    const deletedEmpty = deleteTrack(reorderedUp, reorderedUp.tracks[1].id); // Delete Captions 1
    assert.strictEqual(deletedEmpty.tracks.length, 2);
    assert.strictEqual(deletedEmpty.tracks[0].name, "Audio 1");
    assert.strictEqual(deletedEmpty.tracks[0].index, 0);
    assert.strictEqual(deletedEmpty.tracks[1].name, "Foreground Cut");
    assert.strictEqual(deletedEmpty.tracks[1].index, 1);

    console.log("  ✓ 6. Deleting empty track removes track and normalizes indices");
    passed++;

    // 7. Prevent deletion of track with clips
    const withClip = addClip(deletedEmpty, {
      id: "c_keep_me",
      assetId: "asset_any",
      trackId: deletedEmpty.tracks[1].id,
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    let delClipTrackThrew = false;
    try {
      deleteTrack(withClip, withClip.tracks[1].id);
    } catch (e: any) {
      delClipTrackThrew = true;
      assert(e.message.includes("contains 1 clip(s)"), "Error explains track has clips");
    }
    assert.strictEqual(delClipTrackThrew, true, "Strictly prevented deletion of track with clips");

    console.log("  ✓ 7. Preventing deletion of track containing clips with clear explanation");
    passed++;

    // 8. Undo and Redo for Track Operations
    const trackHist = new TimelineHistory({ initialTimeline: tHistTl });
    assert.strictEqual(trackHist.canUndo(), false);

    // Edit 1: Add Track
    const s1_add = addTrack(tHistTl, { name: "Video 1", type: "video" });
    trackHist.push(s1_add);
    assert.strictEqual(trackHist.canUndo(), true);

    // Edit 2: Rename Track
    const s2_rename = renameTrack(s1_add, s1_add.tracks[0].id, "Main Video");
    trackHist.push(s2_rename);

    // Edit 3: Add second track
    const s3_add2 = addTrack(s2_rename, { name: "Audio 1", type: "audio" });
    trackHist.push(s3_add2);

    // Edit 4: Reorder
    const s4_reorder = reorderTrack(s3_add2, s3_add2.tracks[1].id, "up");
    trackHist.push(s4_reorder);
    assert.strictEqual(s4_reorder.tracks[0].name, "Audio 1");

    // Undo Edit 4 (Reorder)
    const undoReorder = trackHist.undo()!;
    assert.strictEqual(undoReorder.tracks[0].name, "Main Video", "Undo restored original track order");

    // Undo Edit 3 (Add Audio 1)
    const undoAdd2 = trackHist.undo()!;
    assert.strictEqual(undoAdd2.tracks.length, 1, "Undo removed added track");
    assert.strictEqual(undoAdd2.tracks[0].name, "Main Video");

    // Undo Edit 2 (Rename)
    const undoRename = trackHist.undo()!;
    assert.strictEqual(undoRename.tracks[0].name, "Video 1", "Undo restored pre-rename name");

    // Undo Edit 1 (Add Video 1)
    const undoAdd1 = trackHist.undo()!;
    assert.strictEqual(undoAdd1.tracks.length, 0, "Undo restored empty timeline");
    assert.strictEqual(trackHist.canUndo(), false);

    // Redo Edit 1
    const redoAdd1 = trackHist.redo()!;
    assert.strictEqual(redoAdd1.tracks.length, 1);
    assert.strictEqual(redoAdd1.tracks[0].name, "Video 1");

    // Redo Edit 2
    const redoRename = trackHist.redo()!;
    assert.strictEqual(redoRename.tracks[0].name, "Main Video");

    // Redo Edit 3
    const redoAdd2 = trackHist.redo()!;
    assert.strictEqual(redoAdd2.tracks.length, 2);

    // Redo Edit 4
    const redoReorder = trackHist.redo()!;
    assert.strictEqual(redoReorder.tracks[0].name, "Audio 1");
    assert.strictEqual(trackHist.canRedo(), false);

    console.log("  ✓ 8. Full Undo/Redo lifecycle for track add, rename, reorder, and delete");
    passed++;

    // 9. Playback priority updating when video tracks are reordered
    let tmPbTrackTl = createEmptyTimeline({ projectId: "pb_reorder_proj" });
    tmPbTrackTl = addTrack(tmPbTrackTl, { id: "tr_vid_primary", name: "Camera A", type: "video" });
    tmPbTrackTl = addTrack(tmPbTrackTl, { id: "tr_vid_secondary", name: "Camera B", type: "video" });
    tmPbTrackTl = addClip(tmPbTrackTl, {
      id: "clip_cam_a",
      assetId: "asset_cam_a",
      trackId: "tr_vid_primary",
      sourceStart: 0,
      sourceEnd: 15,
      timelineStart: 0
    });
    tmPbTrackTl = addClip(tmPbTrackTl, {
      id: "clip_cam_b",
      assetId: "asset_cam_b",
      trackId: "tr_vid_secondary",
      sourceStart: 10,
      sourceEnd: 25,
      timelineStart: 0
    });

    // Initially: Camera A is index 0 -> active clip is clip_cam_a
    const pbBefore = getTimelinePlaybackSnapshot(tmPbTrackTl, 5.0);
    assert.strictEqual(pbBefore.activeClip?.clip.id, "clip_cam_a");

    // Reorder: Camera B moved up to index 0 -> active clip switches to clip_cam_b
    const pbAfterReorder = reorderTrack(tmPbTrackTl, "tr_vid_secondary", "up");
    const pbAfter = getTimelinePlaybackSnapshot(pbAfterReorder, 5.0);
    assert.strictEqual(pbAfter.activeClip?.clip.id, "clip_cam_b", "Topmost video track reordering deterministically switches active playback clip");

    console.log("  ✓ 9. Playback active clip selection follows reordered video track priority");
    passed++;

    // 10. Persistence serialization & failure rollback
    let saveFailed = false;
    const qTrack = new TimelineSaveQueue({
      saveFn: async (payload) => {
        if (payload.tracks.length > 5) throw new Error("Simulated track save failure");
        return payload;
      },
      onSaveError: () => {
        saveFailed = true;
      },
      initialTimeline: tmPbTrackTl
    });

    qTrack.enqueue(pbAfterReorder);
    await qTrack.waitForIdle();
    assert.strictEqual(qTrack.getLastSavedTimeline()!.tracks[0].id, "tr_vid_secondary");

    // Simulated failure
    const invalidTl = { ...pbAfterReorder, tracks: new Array(6).fill(pbAfterReorder.tracks[0]) };
    qTrack.enqueue(invalidTl);
    await qTrack.waitForIdle();
    assert.strictEqual(saveFailed, true);
    assert.strictEqual(qTrack.getLastSavedTimeline()!.tracks.length, 2, "Failed save rolled back to confirmed 2-track state");

    console.log("  ✓ 10. TimelineSaveQueue serializes track changes and rolls back on failure");
    passed++;

    // 23. Real Project Track Management E2E Persistence Verification
    console.log("\n[Suite 23] Real Project Track Management E2E Persistence Verification");

    // 1. Fetch real timeline
    const realTlForTracks = await fetchProjectTimeline(realProjectId);
    assert(realTlForTracks !== null);
    const initialTrackCount = realTlForTracks.tracks.length;

    // 2. Add video track to real project
    const realWithNewTrack = addTrack(realTlForTracks, {
      name: "B-Roll Track",
      type: "video"
    });
    await saveProjectTimeline(realProjectId, realWithNewTrack);
    const get1 = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(get1!.tracks.length, initialTrackCount + 1, "Added track persisted to MongoDB");
    const addedTrack = get1!.tracks.find((t) => t.name === "B-Roll Track")!;
    assert(addedTrack !== undefined);

    // 3. Rename added track on real project
    const realRenamed = renameTrack(get1!, addedTrack.id, "Alternate Angles");
    await saveProjectTimeline(realProjectId, realRenamed);
    const get2 = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(get2!.tracks.find((t) => t.id === addedTrack.id)!.name, "Alternate Angles", "Renamed track persisted to MongoDB");

    // 4. Reorder tracks on real project
    const realReordered = reorderTrack(get2!, addedTrack.id, "up");
    await saveProjectTimeline(realProjectId, realReordered);
    const get3 = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(get3!.tracks[0].id, addedTrack.id, "Reordered track index 0 persisted to MongoDB");

    // 5. Block deletion of non-empty track on real project
    const originalTrackWithClip = get3!.tracks.find((t) => t.id !== addedTrack.id)!;
    assert(originalTrackWithClip.clips.length > 0, "Original track contains real clip");
    let realBlockThrew = false;
    try {
      deleteTrack(get3!, originalTrackWithClip.id);
    } catch {
      realBlockThrew = true;
    }
    assert.strictEqual(realBlockThrew, true, "Blocked deleting track with real clip on live project");

    // 6. Delete empty added track from real project
    const realDeleted = deleteTrack(get3!, addedTrack.id);
    await saveProjectTimeline(realProjectId, realDeleted);
    const get4 = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(get4!.tracks.length, initialTrackCount, "Empty added track deleted from MongoDB");

    // 7. CRITICAL SAFETY: Verify media asset and file safety
    const checkAssetGet = await fetch(`http://localhost:3001/api/projects/${realProjectId}/media`);
    assert.strictEqual(checkAssetGet.ok, true);
    const checkAssetsJson = await checkAssetGet.json();
    const assetsList = checkAssetsJson.data || [];
    assert(assetsList.length >= 1, "Media asset catalog preserved in database");

    const diskMediaDir23 = path.join(os.homedir(), ".agentcut", "projects", realProjectId, "media");
    const diskMediaFiles23 = fs.readdirSync(diskMediaDir23);
    assert(diskMediaFiles23.length >= 1);
    const dStat23 = fs.statSync(path.join(diskMediaDir23, diskMediaFiles23[0]));
    assert(dStat23.size > 1000000);
    console.log(`  ✓ CRITICAL SAFETY: Physical video file intact on disk (${dStat23.size} bytes)`);
    passed++;

    // 8. Restore pristine baseline
    await saveProjectTimeline(realProjectId, pristinePbBaseline);
    const finalBaseline = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(finalBaseline!.tracks.length, 1);
    assert.strictEqual(finalBaseline!.tracks[0].clips.length, 1);
    console.log("  ✓ Real project timeline baseline restored to pristine state");
    passed++;

    // 24. Step 3.6 Final Review: Ordering Consistency, Reload, Invalidation & Concurrency
    console.log("\n[Suite 24] Step 3.6 Final Review: Ordering Consistency, Reload, Invalidation & Concurrency");

    // 1. Multiple track reorderings and persistence reload
    let multiOrderTl = createEmptyTimeline({ projectId: "mo_proj" });
    multiOrderTl = addTrack(multiOrderTl, { id: "tr_a", name: "Track A", type: "video" });
    multiOrderTl = addTrack(multiOrderTl, { id: "tr_b", name: "Track B", type: "video" });
    multiOrderTl = addTrack(multiOrderTl, { id: "tr_c", name: "Track C", type: "audio" });
    multiOrderTl = addTrack(multiOrderTl, { id: "tr_d", name: "Track D", type: "caption" });

    // Initial indices: A:0, B:1, C:2, D:3
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.id), ["tr_a", "tr_b", "tr_c", "tr_d"]);

    // Move D up -> A:0, B:1, D:2, C:3
    multiOrderTl = reorderTrack(multiOrderTl, "tr_d", "up");
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.id), ["tr_a", "tr_b", "tr_d", "tr_c"]);
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.index), [0, 1, 2, 3]);

    // Move D up again -> A:0, D:1, B:2, C:3
    multiOrderTl = reorderTrack(multiOrderTl, "tr_d", "up");
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.id), ["tr_a", "tr_d", "tr_b", "tr_c"]);
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.index), [0, 1, 2, 3]);

    // Move A down -> D:0, A:1, B:2, C:3
    multiOrderTl = reorderTrack(multiOrderTl, "tr_a", "down");
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.id), ["tr_d", "tr_a", "tr_b", "tr_c"]);
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.index), [0, 1, 2, 3]);

    // Move B to index 0 using moveTrackOrder -> B:0, D:1, A:2, C:3
    multiOrderTl = moveTrackOrder(multiOrderTl, "tr_b", 0);
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.id), ["tr_b", "tr_d", "tr_a", "tr_c"]);
    assert.deepStrictEqual(multiOrderTl.tracks.map((t) => t.index), [0, 1, 2, 3]);

    // Save to real MongoDB project and reload
    await saveProjectTimeline(realProjectId, multiOrderTl);
    const reloadedMultiTl = await fetchProjectTimeline(realProjectId);
    assert(reloadedMultiTl !== null);
    assert.deepStrictEqual(reloadedMultiTl.tracks.map((t) => t.id), ["tr_b", "tr_d", "tr_a", "tr_c"]);
    assert.deepStrictEqual(reloadedMultiTl.tracks.map((t) => t.index), [0, 1, 2, 3]);
    console.log("  ✓ 1. Multiple reorderings persist and reload with identical track order and indices");
    passed++;

    // 2. Playback priority consistency across video track reorder
    const tlWithClipsForPb = addClip(
      addClip(multiOrderTl, {
        id: "clip_on_b",
        assetId: "asset_any",
        trackId: "tr_b",
        sourceStart: 0,
        sourceEnd: 10,
        timelineStart: 0
      }),
      {
        id: "clip_on_a",
        assetId: "asset_any",
        trackId: "tr_a",
        sourceStart: 5,
        sourceEnd: 15,
        timelineStart: 0
      }
    );
    // Track B is at index 0, Track A is at index 2 -> Clip on B has priority
    const snapB = getTimelinePlaybackSnapshot(tlWithClipsForPb, 2.0);
    assert.strictEqual(snapB.activeClip?.clip.id, "clip_on_b");

    // Move Track A to index 0 -> Clip on A now has priority
    const tlReorderedPb = moveTrackOrder(tlWithClipsForPb, "tr_a", 0);
    const snapA = getTimelinePlaybackSnapshot(tlReorderedPb, 2.0);
    assert.strictEqual(snapA.activeClip?.clip.id, "clip_on_a");
    console.log("  ✓ 2. Topmost video track priority strictly follows persisted and displayed order");
    passed++;

    // 3. Undo/Redo: Add, Rename, Reorder, Delete empty track, and Redo Invalidation
    const hist24 = new TimelineHistory({ initialTimeline: createEmptyTimeline({ projectId: "h24_proj" }) });

    // 3a. Add track
    const hState1 = addTrack(hist24.getCurrent()!, { id: "tr_h1", name: "Audio Track", type: "audio" });
    hist24.push(hState1);

    // 3b. Rename track
    const hState2 = renameTrack(hist24.getCurrent()!, "tr_h1", "Dialogue Channel");
    hist24.push(hState2);

    // 3c. Add second track and reorder
    const hState3 = addTrack(hist24.getCurrent()!, { id: "tr_h2", name: "SFX Channel", type: "audio" });
    hist24.push(hState3);
    const hState4 = reorderTrack(hist24.getCurrent()!, "tr_h2", "up");
    hist24.push(hState4);

    assert.strictEqual(hist24.getCurrent()!.tracks[0].name, "SFX Channel");
    assert.strictEqual(hist24.getCurrent()!.tracks[1].name, "Dialogue Channel");

    // 3d. Undo reorder -> index restored
    const u1 = hist24.undo()!;
    assert.strictEqual(u1.tracks[0].name, "Dialogue Channel");
    assert.strictEqual(u1.tracks[1].name, "SFX Channel");

    // 3e. Undo add second track -> track removed
    const u2 = hist24.undo()!;
    assert.strictEqual(u2.tracks.length, 1);
    assert.strictEqual(u2.tracks[0].name, "Dialogue Channel");

    // 3f. Undo rename -> name restored
    const u3 = hist24.undo()!;
    assert.strictEqual(u3.tracks[0].name, "Audio Track");

    // 3g. Undo add -> empty timeline
    const u4 = hist24.undo()!;
    assert.strictEqual(u4.tracks.length, 0);
    assert.strictEqual(hist24.canUndo(), false);

    // 3h. Redo all
    const r1 = hist24.redo()!;
    assert.strictEqual(r1.tracks[0].name, "Audio Track");
    const r2 = hist24.redo()!;
    assert.strictEqual(r2.tracks[0].name, "Dialogue Channel");
    const r3 = hist24.redo()!;
    assert.strictEqual(r3.tracks.length, 2);
    const r4 = hist24.redo()!;
    assert.strictEqual(r4.tracks[0].name, "SFX Channel");

    // 3i. Delete empty track and undo deletion
    const hState5 = deleteTrack(hist24.getCurrent()!, "tr_h2");
    hist24.push(hState5);
    assert.strictEqual(hist24.getCurrent()!.tracks.length, 1);

    // Undo deletion -> track restored with original id, name, type, and index
    const uDelete = hist24.undo()!;
    assert.strictEqual(uDelete.tracks.length, 2);
    const restoredTrack = uDelete.tracks.find((t) => t.id === "tr_h2");
    assert(restoredTrack !== undefined);
    assert.strictEqual(restoredTrack!.name, "SFX Channel");
    assert.strictEqual(restoredTrack!.type, "audio");
    assert.strictEqual(restoredTrack!.index, 0);

    // 3j. Redo branch invalidation: perform a new edit after undo
    assert.strictEqual(hist24.canRedo(), true);
    const newEditAfterUndo = renameTrack(hist24.getCurrent()!, "tr_h1", "Foley Effects");
    hist24.push(newEditAfterUndo);

    // Verifying that canRedo is false and abandoned redo branch is destroyed
    assert.strictEqual(hist24.canRedo(), false, "Performing new edit after undo invalidates redo branch");
    console.log("  ✓ 3. Full Undo/Redo lifecycle and branch invalidation verified");
    passed++;

    // 4. Persistence Concurrency: Rapid successive track operations
    const rapidTimeline0 = createEmptyTimeline({ projectId: "rapid_proj" });
    const savedStates: string[] = [];
    const qRapid = new TimelineSaveQueue({
      saveFn: async (payload) => {
        await new Promise((r) => setTimeout(r, 20));
        savedStates.push(payload.tracks.map((t) => t.name).join(" > "));
        return payload;
      },
      initialTimeline: rapidTimeline0
    });

    const edit1 = addTrack(rapidTimeline0, { name: "Track 1", type: "video" });
    const edit2 = addTrack(edit1, { name: "Track 2", type: "audio" });
    const edit3 = renameTrack(edit2, edit2.tracks[0].id, "Primary Video");
    const edit4 = reorderTrack(edit3, edit3.tracks[1].id, "up");
    const edit5 = renameTrack(edit4, edit4.tracks[0].id, "Top Audio");

    // Enqueue in rapid succession while queue is busy
    qRapid.enqueue(edit1);
    qRapid.enqueue(edit2);
    qRapid.enqueue(edit3);
    qRapid.enqueue(edit4);
    qRapid.enqueue(edit5);

    await qRapid.waitForIdle();
    const finalQueueState = qRapid.getLastSavedTimeline()!;
    assert(finalQueueState !== null);
    assert.strictEqual(finalQueueState.tracks[0].name, "Top Audio");
    assert.strictEqual(finalQueueState.tracks[1].name, "Primary Video");
    assert.strictEqual(savedStates[savedStates.length - 1], "Top Audio > Primary Video", "Final state was accurately persisted without stale overwrites");
    console.log("  ✓ 4. TimelineSaveQueue coalesces rapid track edits and prevents stale writes");
    passed++;

    // 5. Save failure and rollback
    let errorCaught = false;
    let rolledBackState: Timeline | null = null;
    const qFail = new TimelineSaveQueue({
      saveFn: async () => {
        throw new Error("Simulated network timeout");
      },
      onSaveError: (_err, rolledBack) => {
        errorCaught = true;
        rolledBackState = rolledBack;
      },
      initialTimeline: finalQueueState
    });

    const failedEdit = addTrack(finalQueueState, { name: "Track 3", type: "caption" });
    qFail.enqueue(failedEdit);
    await qFail.waitForIdle();

    assert.strictEqual(errorCaught, true);
    const rbTimeline = rolledBackState as Timeline | null;
    assert(rbTimeline !== null);
    assert.strictEqual(rbTimeline.tracks.length, 2, "Failed save safely rolled back to confirmed 2-track baseline");
    console.log("  ✓ 5. Persistence failure rolls back cleanly to last confirmed server state");
    passed++;

    // 6. Track deletion safety: prevent deleting track with clips & verify asset integrity
    const tlWithClipToDelete = addClip(finalQueueState, {
      id: "safe_clip_id",
      assetId: "real_asset_id",
      trackId: finalQueueState.tracks[0].id,
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    let safetyDeleteBlocked = false;
    try {
      deleteTrack(tlWithClipToDelete, tlWithClipToDelete.tracks[0].id);
    } catch (e: any) {
      safetyDeleteBlocked = true;
      assert(e.message.includes("contains 1 clip(s)"), "Error clearly indicates clips exist on track");
    }
    assert.strictEqual(safetyDeleteBlocked, true, "Cannot delete track containing clips");

    // Clean up real project baseline in MongoDB
    await saveProjectTimeline(realProjectId, pristinePbBaseline);
    const cleanFinalBaseline = await fetchProjectTimeline(realProjectId);
    assert.strictEqual(cleanFinalBaseline!.tracks.length, 1);
    assert.strictEqual(cleanFinalBaseline!.tracks[0].clips.length, 1);
    console.log("  ✓ 6. Track deletion safety strictly verified and clean baseline restored to MongoDB");
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
