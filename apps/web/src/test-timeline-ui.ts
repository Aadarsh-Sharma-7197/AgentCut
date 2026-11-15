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
  isTrackTypeCompatible,
  BASE_PIXELS_PER_SECOND,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM
} from "./utils/timelineCalculations.js";
import {
  moveClip,
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

  // 10. Live Vite Dev Server & API Proxy Verification
  console.log("\n[Suite 10] Live Vite Dev Server & API Proxy Verification");
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

    // 1. Fetch current timeline for real project via Vite proxy
    const tlCurrent = await fetchProjectTimeline(realProjectId);
    assert(tlCurrent !== null, "Timeline exists for 'My Project'");
    assert(tlCurrent.tracks.length > 0, "Timeline contains tracks");
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
