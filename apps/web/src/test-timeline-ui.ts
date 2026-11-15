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
  BASE_PIXELS_PER_SECOND,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM
} from "./utils/timelineCalculations.js";
import type { Clip } from "@agentcut/shared";

console.log("=== AgentCut Timeline UI & Calculations Verification Suite ===\n");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
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
    // When zoomed in, tick intervals should be finer (e.g. 0.5s or 1s)
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

  // 7. Live Server & Vite Proxy End-to-End Smoke Test
  console.log("\n[Suite 7] Live Vite Dev Server & API Proxy Verification");
  try {
    // Check Vite serving index.html
    const viteRes = await fetch("http://localhost:3000/");
    assert.strictEqual(viteRes.status, 200);
    const htmlText = await viteRes.text();
    assert(htmlText.includes("AgentCut"), "Vite serves HTML with AgentCut title");
    console.log("  ✓ PASS: Vite dev server running on http://localhost:3000 and serving index.html");
    passed++;

    // Check Vite proxy forwarding to Express on port 3001
    const healthRes = await fetch("http://localhost:3000/api/projects");
    assert.strictEqual(healthRes.status, 200);
    console.log("  ✓ PASS: Vite proxy successfully forwards /api requests to Express server");
    passed++;

    // Create a temporary project through Vite proxy to verify timeline lifecycle
    const createRes = await fetch("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Timeline UI Smoke Test Temp" })
    });
    assert.strictEqual(createRes.status, 201);
    const createJson = (await createRes.json()) as { data: { id: string } };
    const tempProjectId = createJson.data.id;
    console.log("  ✓ PASS: Created temporary project through Vite dev proxy");
    passed++;

    // Test GET /timeline on new project through proxy: must return 404 Timeline not found
    const tlGetEmptyRes = await fetch(`http://localhost:3000/api/projects/${tempProjectId}/timeline`);
    assert.strictEqual(tlGetEmptyRes.status, 404);
    const tlGetEmptyJson = (await tlGetEmptyRes.json()) as { error?: string };
    assert(tlGetEmptyJson.error?.includes("Timeline not found"), "Returns 404 with 'Timeline not found'");
    console.log("  ✓ PASS: Empty timeline state correctly returns 404 via proxy");
    passed++;

    // Save a valid empty-track timeline via proxy
    const putTlRes = await fetch(`http://localhost:3000/api/projects/${tempProjectId}/timeline`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tracks: [
          { id: "tr_v1", name: "Video 1", type: "video", index: 0, enabled: true, clips: [] },
          { id: "tr_a1", name: "Audio 1", type: "audio", index: 1, enabled: true, clips: [] }
        ],
        settings: { frameRate: 30 }
      })
    });
    assert.strictEqual(putTlRes.status, 200);
    console.log("  ✓ PASS: PUT timeline with empty tracks succeeds via proxy");
    passed++;

    // Fetch timeline again via proxy
    const tlGetRes = await fetch(`http://localhost:3000/api/projects/${tempProjectId}/timeline`);
    assert.strictEqual(tlGetRes.status, 200);
    const tlGetJson = (await tlGetRes.json()) as { data: { tracks: Array<{ id: string }> } };
    assert.strictEqual(tlGetJson.data.tracks.length, 2);
    console.log("  ✓ PASS: GET saved timeline retrieves 2 tracks via proxy");
    passed++;

    // Clean up temporary project via proxy
    const delRes = await fetch(`http://localhost:3000/api/projects/${tempProjectId}`, {
      method: "DELETE"
    });
    assert.strictEqual(delRes.status, 200);
    console.log("  ✓ PASS: Temporary test project deleted cleanly via proxy");
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

