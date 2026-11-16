process.env.NODE_ENV = "test";

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import { spawnSync } from "child_process";

dotenv.config({ path: "./apps/server/.env" });
dotenv.config({ path: path.resolve(process.cwd(), "apps/server/.env") });

const { default: app } = await import("./index.js");
import crypto from "crypto";
import { connectDB, closeDB, getDB } from "./config/db.js";
import {
  getProjectMediaDir,
  resolveStoredFilePath,
  getProjectExportDir,
  resolveExportFilePath,
  getAssetAnalysisDir,
  resolveAssetAnalysisAudioPath,
  resolveAssetAnalysisTempAudioPath
} from "./config/storage.js";
import { getFFprobePath, inspectVideo, inspectAudioFile } from "./utils/ffprobe.js";
import { getFFmpegPath, checkFFmpegAvailable, validateFFmpegSafety } from "./utils/ffmpeg.js";
import {
  buildFFmpegRenderArgs,
  verifyRenderOutput,
  executeRenderJob,
  isJobActive,
  cancelActiveRender
} from "./services/render-pipeline.service.js";
import {
  requestAudioExtraction,
  getAudioExtraction,
  cancelActiveExtraction,
  isExtractionActive
} from "./services/audio-extraction.service.js";
import {
  detectSilence,
  getSilenceDetection,
  cancelActiveSilenceDetection,
  isSilenceDetectionActive,
  parseSilenceDetectOutput,
  validateSilenceDetectionParameters
} from "./services/silence-detection.service.js";
import {
  requestTranscription,
  getTranscription,
  getTranscriptionWithTranscript,
  cancelTranscription,
  isTranscriptionActive,
  validateTranscriptionParameters,
  validateTranscriptData,
  ALLOWED_MODELS
} from "./services/transcription.service.js";
import {
  probeWorkerHardware,
  sendRequestToWorker,
  setMockWorkerHandler,
  ensureWorkerRunning,
  stopWorker,
  isWorkerAlive
} from "./services/transcription-worker.service.js";
import {
  getAssetTranscriptionDir,
  resolveAssetTranscriptPath,
  resolveAssetTranscriptTempPath,
  getAssetScenesDir,
  getSceneAnalysisDir,
  resolveSceneFramePath
} from "./config/storage.js";
import {
  requestSceneDetection,
  getSceneDetection,
  cancelActiveSceneDetection,
  isSceneDetectionActive,
  validateSceneDetectionParameters,
  parseShowinfoStderr,
  buildSceneIntervals,
  getSceneFrame,
  isProcessExited,
  terminateProcessWithGracePeriod,
  terminateJobProcesses,
  DEFAULT_THRESHOLD,
  DEFAULT_MIN_SCENE_DURATION,
  DEFAULT_MAX_SCENES,
  MAX_ALLOWED_SCENES
} from "./services/scene-detection.service.js";
import { ObjectId } from "mongodb";
import type { Server } from "http";

async function runTests() {
  console.log("=== AgentCut Timeline Persistence Verification Test Suite ===");
  const serverPort = 3999;
  let server: Server;

  await connectDB();

  await new Promise<void>((resolve) => {
    server = app.listen(serverPort, () => {
      console.log(`[Test Server] Started on http://localhost:${serverPort}`);
      resolve();
    });
  });

  const baseUrl = `http://localhost:${serverPort}`;
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ""}`);
      failed++;
    }
  }

  // Pre-generate synthetic test files using ffmpeg if available
  const tempDir = os.tmpdir();
  const validMp4Path = path.join(tempDir, "agentcut_valid_test.mp4");
  const audioOnlyMp4Path = path.join(tempDir, "agentcut_audio_test.mp4");
  const videoWithAudioPath = path.join(tempDir, "agentcut_video_with_audio_test.mp4");
  const videoWithoutAudioPath = path.join(tempDir, "agentcut_video_no_audio_test.mp4");

  const ffprobePath = getFFprobePath();
  const ffmpegPath = ffprobePath.replace(/ffprobe(\.exe)?$/i, "ffmpeg$1");

  console.log(`[Setup] Using FFprobe path: ${ffprobePath}`);

  if (fs.existsSync(ffmpegPath)) {
    // Generate 1-sec 320x240 valid video
    spawnSync(
      ffmpegPath,
      ["-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", validMp4Path],
      { stdio: "ignore" }
    );
    // Generate 1-sec audio-only file
    spawnSync(
      ffmpegPath,
      ["-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-c:a", "aac", "-vn", "-y", audioOnlyMp4Path],
      { stdio: "ignore" }
    );
    // Generate 2-sec video with AAC audio
    spawnSync(
      ffmpegPath,
      [
        "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-y", videoWithAudioPath
      ],
      { stdio: "ignore" }
    );
    // Generate 1-sec video without audio stream
    spawnSync(
      ffmpegPath,
      [
        "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-an",
        "-y", videoWithoutAudioPath
      ],
      { stdio: "ignore" }
    );
  }

  try {
    // ----------------------------------------------------
    // 1. Health check endpoint
    // ----------------------------------------------------
    console.log("\n[Test 1] Health Check Endpoint");
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert(healthRes.status === 200, "GET /health returns 200");
    assert(healthJson.status === "ok", "Health status is 'ok'");

    // ----------------------------------------------------
    // 2. Project Creation & Setup
    // ----------------------------------------------------
    console.log("\n[Test 2] Create Test Projects");
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Media & Timeline Test Project ${Date.now()}` })
    });
    assert(createProjectRes.status === 201, "Project 1 created successfully");
    const projectData = ((await createProjectRes.json()) as { data: { id: string } }).data;
    const projectId = projectData.id;

    // Create a secondary project for cross-project boundary testing
    const createProj2Res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Secondary Project" })
    });
    const project2Id = ((await createProj2Res.json()) as { data: { id: string } }).data.id;

    // ----------------------------------------------------
    // 3. Reject upload to Nonexistent Project
    // ----------------------------------------------------
    console.log("\n[Test 3] Reject Upload to Nonexistent Project");
    const fakeProjectId = "000000000000000000000000";
    const fakeFormData = new FormData();
    fakeFormData.append("file", new Blob(["mock"], { type: "video/mp4" }), "sample.mp4");
    const fakeProjRes = await fetch(`${baseUrl}/api/projects/${fakeProjectId}/media`, {
      method: "POST",
      body: fakeFormData
    });
    assert(fakeProjRes.status === 404, "Upload to nonexistent project returns 404");

    // ----------------------------------------------------
    // 4. Reject Unsupported File Extension
    // ----------------------------------------------------
    console.log("\n[Test 4] Reject Unsupported Extension");
    const txtFormData = new FormData();
    txtFormData.append("file", new Blob(["not a video"], { type: "text/plain" }), "sample.txt");
    const txtRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
      method: "POST",
      body: txtFormData
    });
    assert(txtRes.status === 400, "Unsupported extension rejected (.txt) with 400");

    // ----------------------------------------------------
    // 5. Reject Invalid / Corrupt Video Content
    // ----------------------------------------------------
    console.log("\n[Test 5] Reject Corrupt Content with .mp4 Extension");
    const corruptFormData = new FormData();
    corruptFormData.append("file", new Blob(["random corrupted bytes header"], { type: "video/mp4" }), "corrupt.mp4");
    const corruptRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
      method: "POST",
      body: corruptFormData
    });
    assert(corruptRes.status === 400, "Corrupt file with .mp4 extension rejected with 400");
    const corruptJson = (await corruptRes.json()) as { error?: string };
    assert(Boolean(corruptJson.error), "Returns descriptive inspection error message");

    // ----------------------------------------------------
    // 6. Reject Audio-Only File
    // ----------------------------------------------------
    console.log("\n[Test 6] Reject Audio-Only File");
    let audioOnlyAssetId = "";
    if (fs.existsSync(audioOnlyMp4Path)) {
      const audioBuffer = fs.readFileSync(audioOnlyMp4Path);
      const audioFormData = new FormData();
      audioFormData.append("file", new Blob([audioBuffer], { type: "video/mp4" }), "audio_only.mp4");
      const audioRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: audioFormData
      });
      assert(audioRes.status === 400, "Audio-only file rejected with 400");
      const audioJson = (await audioRes.json()) as { error?: string };
      assert(
        audioJson.error?.includes("does not contain a valid video stream") || false,
        "Error specifies lack of video stream"
      );
    }

    // ----------------------------------------------------
    // 7. Verify Cleanup of Failed Upload (No Orphan Files)
    // ----------------------------------------------------
    console.log("\n[Test 7] Verify Failed Upload Cleanup");
    const mediaDir = getProjectMediaDir(projectId);
    const filesBeforeFailedUpload = fs.readdirSync(mediaDir);
    const failFormData = new FormData();
    failFormData.append("file", new Blob(["bad data"], { type: "video/mp4" }), "fail.mp4");
    await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
      method: "POST",
      body: failFormData
    });
    const filesAfterFailedUpload = fs.readdirSync(mediaDir);
    assert(
      filesBeforeFailedUpload.length === filesAfterFailedUpload.length,
      "Incomplete/rejected upload was removed from disk without leaving orphans"
    );

    // ----------------------------------------------------
    // 8. Upload Valid Video & Inspect Metadata
    // ----------------------------------------------------
    console.log("\n[Test 8] Upload Valid Video");
    let validAssetId = "";
    if (fs.existsSync(validMp4Path)) {
      const validBuffer = fs.readFileSync(validMp4Path);
      const validFormData = new FormData();
      validFormData.append("file", new Blob([validBuffer], { type: "video/mp4" }), "valid_video.mp4");
      const validRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: validFormData
      });
      assert(validRes.status === 201, "POST /api/projects/:id/media returns 201 Created");
      const validJson = (await validRes.json()) as {
        data: {
          id: string;
          projectId: string;
          originalName: string;
          width: number;
          height: number;
          duration: number;
          videoCodec: string;
          fileSize: number;
        };
      };
      validAssetId = validJson.data.id;
      assert(Boolean(validAssetId), "Media asset ID was returned");
      assert(validJson.data.projectId === projectId, "Asset belongs to correct project");
      assert(validJson.data.originalName === "valid_video.mp4", "Original filename is preserved in metadata");
      assert(validJson.data.width === 320, "Video width extracted accurately (320)");
      assert(validJson.data.height === 240, "Video height extracted accurately (240)");
      assert(validJson.data.duration > 0, "Video duration extracted accurately (>0s)");
      assert(validJson.data.videoCodec === "h264", "Video codec identified as h264");

      // Also upload an asset to project 2 for cross-project asset testing
      const proj2FormData = new FormData();
      proj2FormData.append("file", new Blob([validBuffer], { type: "video/mp4" }), "proj2_video.mp4");
      const proj2MediaRes = await fetch(`${baseUrl}/api/projects/${project2Id}/media`, {
        method: "POST",
        body: proj2FormData
      });
      const proj2AssetId = ((await proj2MediaRes.json()) as { data: { id: string } }).data.id;

      // ----------------------------------------------------
      // 9. List Media for Project
      // ----------------------------------------------------
      console.log("\n[Test 9] List Media for Project");
      const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`);
      assert(listRes.status === 200, "GET /api/projects/:id/media returns 200");
      const listJson = (await listRes.json()) as { data: Array<{ id: string }> };
      assert(Array.isArray(listJson.data), "Media listing returns array");
      assert(
        listJson.data.some((item) => item.id === validAssetId),
        "Newly uploaded asset appears in project media library"
      );

      // ----------------------------------------------------
      // 10. Retrieve Single Media Asset Details
      // ----------------------------------------------------
      console.log("\n[Test 10] Retrieve Single Asset Details");
      const getAssetRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${validAssetId}`);
      assert(getAssetRes.status === 200, "GET /api/projects/:id/media/:assetId returns 200");
      const getAssetJson = (await getAssetRes.json()) as { data: { id: string } };
      assert(getAssetJson.data.id === validAssetId, "Retrieved asset matches requested ID");

      // ----------------------------------------------------
      // 11. Cross-Project Access Protection
      // ----------------------------------------------------
      console.log("\n[Test 11] Prevent Cross-Project Asset Access");
      const crossRes = await fetch(`${baseUrl}/api/projects/${project2Id}/media/${validAssetId}`);
      assert(crossRes.status === 404, "Requesting asset under another project ID returns 404");

      // ----------------------------------------------------
      // 12. Video Streaming & HTTP Range Requests
      // ----------------------------------------------------
      console.log("\n[Test 12] Video Streaming and HTTP Range Requests");
      const streamUrl = `${baseUrl}/api/projects/${projectId}/media/${validAssetId}/stream`;

      const fullStreamRes = await fetch(streamUrl);
      assert(fullStreamRes.status === 200, "Stream without Range returns 200 OK");
      assert(fullStreamRes.headers.get("accept-ranges") === "bytes", "Accept-Ranges: bytes is advertised");

      const rangeRes = await fetch(streamUrl, {
        headers: { Range: "bytes=0-100" }
      });
      assert(rangeRes.status === 206, "Range request returns 206 Partial Content");
      assert(rangeRes.headers.get("content-length") === "101", "Chunk size is exactly 101 bytes");

      // ====================================================
      // TIMELINE PERSISTENCE TESTS (Phase 1, Step 3)
      // ====================================================

      // ----------------------------------------------------
      // 13. Project with No Saved Timeline (404)
      // ----------------------------------------------------
      console.log("\n[Test 13] GET Timeline on Project with No Saved Timeline");
      const noTimelineRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`);
      assert(noTimelineRes.status === 404, "GET timeline on new project returns 404");
      const noTimelineJson = (await noTimelineRes.json()) as { error?: string };
      assert(
        noTimelineJson.error === "Timeline not found for this project.",
        "Error message specifies timeline not found for project"
      );

      // ----------------------------------------------------
      // 14. Nonexistent Project on GET & PUT Timeline
      // ----------------------------------------------------
      console.log("\n[Test 14] GET & PUT Timeline on Nonexistent Project");
      const getNonexistentProjTl = await fetch(`${baseUrl}/api/projects/${fakeProjectId}/timeline`);
      assert(getNonexistentProjTl.status === 404, "GET timeline on nonexistent project returns 404");
      const getNonexistentJson = (await getNonexistentProjTl.json()) as { error?: string };
      assert(getNonexistentJson.error === "Project not found.", "Error specifies project not found");

      const putNonexistentProjTl = await fetch(`${baseUrl}/api/projects/${fakeProjectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [],
          settings: { frameRate: 30 }
        })
      });
      assert(putNonexistentProjTl.status === 404, "PUT timeline on nonexistent project returns 404");

      // ----------------------------------------------------
      // 15. Mismatched Project ID in Body
      // ----------------------------------------------------
      console.log("\n[Test 15] Reject Mismatched Project ID in Request Body");
      const mismatchRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "different_project_id",
          tracks: [],
          settings: { frameRate: 30 }
        })
      });
      assert(mismatchRes.status === 400, "Mismatched project ID in body returns 400 Bad Request");
      const mismatchJson = (await mismatchRes.json()) as { error?: string };
      assert(
        mismatchJson.error?.includes("does not match route parameter") || false,
        "Error specifies project ID mismatch"
      );

      // ----------------------------------------------------
      // 16. Invalid Timeline Structure & Malformed Request Bodies
      // ----------------------------------------------------
      console.log("\n[Test 16] Reject Invalid Timeline Structure & Malformed Bodies");
      const malformedNullRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(null)
      });
      assert(malformedNullRes.status === 400, "Malformed null body rejected with 400");

      const malformedArrayRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not", "an", "object"])
      });
      assert(malformedArrayRes.status === 400, "Malformed array body rejected with 400");

      const invalidStructRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: "not-an-array",
          settings: { frameRate: 30 }
        })
      });
      assert(invalidStructRes.status === 400, "Non-array tracks rejected with 400");

      const invalidSettingsRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [],
          settings: { frameRate: -10 }
        })
      });
      assert(invalidSettingsRes.status === 400, "Negative frameRate in settings rejected with 400");

      // ----------------------------------------------------
      // 17. Missing Media Asset Reference
      // ----------------------------------------------------
      console.log("\n[Test 17] Reject Missing Media Asset in Clips");
      const missingAssetRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [
            {
              id: "tr_v1",
              name: "Video 1",
              type: "video",
              index: 0,
              enabled: true,
              clips: [
                {
                  id: "cl_ghost",
                  assetId: "nonexistent_asset_id",
                  trackId: "tr_v1",
                  sourceStart: 0,
                  sourceEnd: 5,
                  timelineStart: 0
                }
              ]
            }
          ],
          settings: { frameRate: 30 }
        })
      });
      assert(missingAssetRes.status === 400, "Clip referencing nonexistent media asset returns 400");
      const missingAssetJson = (await missingAssetRes.json()) as { details?: Array<{ message: string }> };
      assert(
        Boolean(missingAssetJson.details?.some((d) => d.message.includes("nonexistent media asset"))),
        "Validation details report nonexistent media asset"
      );

      // ----------------------------------------------------
      // 18. Media Asset Belonging to Another Project
      // ----------------------------------------------------
      console.log("\n[Test 18] Reject Cross-Project Media Asset in Clips");
      const crossProjectAssetRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [
            {
              id: "tr_v1",
              name: "Video 1",
              type: "video",
              index: 0,
              enabled: true,
              clips: [
                {
                  id: "cl_cross",
                  assetId: proj2AssetId, // belongs to project2Id!
                  trackId: "tr_v1",
                  sourceStart: 0,
                  sourceEnd: 1,
                  timelineStart: 0
                }
              ]
            }
          ],
          settings: { frameRate: 30 }
        })
      });
      assert(crossProjectAssetRes.status === 400, "Asset belonging to another project is rejected with 400");

      // ----------------------------------------------------
      // 19. Track / Media Compatibility
      // ----------------------------------------------------
      console.log("\n[Test 19] Reject Incompatible Track / Media Combinations");
      // Video asset on caption track
      const videoOnCaptionRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [
            {
              id: "tr_c1",
              name: "Captions",
              type: "caption",
              index: 0,
              enabled: true,
              clips: [
                {
                  id: "cl_bad_caption",
                  assetId: validAssetId, // Video asset!
                  trackId: "tr_c1",
                  sourceStart: 0,
                  sourceEnd: 1,
                  timelineStart: 0
                }
              ]
            }
          ],
          settings: { frameRate: 30 }
        })
      });
      assert(videoOnCaptionRes.status === 400, "Video asset placed on caption track returns 400");

      // ----------------------------------------------------
      // 20. Invalid Timing Values in Clips
      // ----------------------------------------------------
      console.log("\n[Test 20] Reject Invalid Timing Values in Clips");
      const invTimingRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [
            {
              id: "tr_v1",
              name: "Video 1",
              type: "video",
              index: 0,
              enabled: true,
              clips: [
                {
                  id: "cl_inv_time",
                  assetId: validAssetId,
                  trackId: "tr_v1",
                  sourceStart: 10,
                  sourceEnd: 5, // end < start
                  timelineStart: -2 // negative timelineStart
                }
              ]
            }
          ],
          settings: { frameRate: 30 }
        })
      });
      assert(invTimingRes.status === 400, "Invalid timing values return 400 Bad Request");

      // ----------------------------------------------------
      // 21. Save New Valid Timeline
      // ----------------------------------------------------
      console.log("\n[Test 21] Save New Valid Timeline");
      const saveValidTlRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "tl_custom_stable_id",
          tracks: [
            {
              id: "tr_v1",
              name: "Video Track 1",
              type: "video",
              index: 0,
              enabled: true,
              clips: [
                {
                  id: "cl_1",
                  assetId: validAssetId,
                  trackId: "tr_v1",
                  sourceStart: 0,
                  sourceEnd: 0.8,
                  timelineStart: 0,
                  name: "Shot 1"
                }
              ]
            }
          ],
          settings: { frameRate: 30, width: 1920, height: 1080 }
        })
      });
      assert(saveValidTlRes.status === 200, "PUT valid timeline returns 200 OK");
      const savedTlJson = (await saveValidTlRes.json()) as {
        data: {
          id: string;
          projectId: string;
          tracks: Array<{ id: string; clips: Array<{ id: string }> }>;
          createdAt: string;
          updatedAt: string;
        };
      };
      const initialTimelineId = savedTlJson.data.id;
      const initialCreatedAt = savedTlJson.data.createdAt;
      assert(initialTimelineId === "tl_custom_stable_id", "Timeline preserved stable ID");
      assert(savedTlJson.data.projectId === projectId, "Timeline has correct projectId");
      assert(savedTlJson.data.tracks[0].clips.length === 1, "Timeline contains 1 clip");
      assert(Boolean(initialCreatedAt), "Server timestamp createdAt is present");

      // ----------------------------------------------------
      // 22. Retrieve Saved Timeline
      // ----------------------------------------------------
      console.log("\n[Test 22] Retrieve Saved Timeline");
      const getSavedTlRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`);
      assert(getSavedTlRes.status === 200, "GET saved timeline returns 200 OK");
      const retrievedTlJson = (await getSavedTlRes.json()) as {
        data: {
          id: string;
          projectId: string;
          tracks: Array<{ id: string; clips: Array<{ id: string }> }>;
        };
      };
      assert(retrievedTlJson.data.id === initialTimelineId, "Retrieved timeline ID matches");
      assert(retrievedTlJson.data.tracks[0].clips[0].id === "cl_1", "Retrieved clip matches");

      // ----------------------------------------------------
      // 23. Update Existing Timeline (Preserving Stable ID)
      // ----------------------------------------------------
      console.log("\n[Test 23] Update Existing Timeline");
      // Add a second clip to the track
      const updateTlRes = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [
            {
              id: "tr_v1",
              name: "Video Track 1",
              type: "video",
              index: 0,
              enabled: true,
              clips: [
                {
                  id: "cl_1",
                  assetId: validAssetId,
                  trackId: "tr_v1",
                  sourceStart: 0,
                  sourceEnd: 0.5,
                  timelineStart: 0,
                  name: "Shot 1 (Trimmed)"
                },
                {
                  id: "cl_2",
                  assetId: validAssetId,
                  trackId: "tr_v1",
                  sourceStart: 0.5,
                  sourceEnd: 1.0,
                  timelineStart: 1.0,
                  name: "Shot 2"
                }
              ]
            }
          ],
          settings: { frameRate: 30, width: 1920, height: 1080 }
        })
      });
      assert(updateTlRes.status === 200, "PUT update timeline returns 200 OK");
      const updatedTlJson = (await updateTlRes.json()) as {
        data: {
          id: string;
          tracks: Array<{ clips: Array<{ id: string }> }>;
          createdAt: string;
          updatedAt: string;
        };
      };
      assert(updatedTlJson.data.id === initialTimelineId, "Stable timeline ID preserved across update");
      assert(updatedTlJson.data.createdAt === initialCreatedAt, "Original createdAt timestamp preserved");
      assert(updatedTlJson.data.tracks[0].clips.length === 2, "Timeline now contains 2 clips");

      // Verify concurrent updates preserve stable ID and createdAt atomically
      console.log("  - Verifying concurrent updates preserve stable ID and timestamps");
      const concurrentRequests = Array.from({ length: 5 }, (_, idx) =>
        fetch(`${baseUrl}/api/projects/${projectId}/timeline`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `tl_concurrent_attempt_${idx}`,
            tracks: [
              {
                id: "tr_v1",
                name: "Video Track 1",
                type: "video",
                index: 0,
                enabled: true,
                clips: [
                  {
                    id: `cl_concurrent_${idx}`,
                    assetId: validAssetId,
                    trackId: "tr_v1",
                    sourceStart: 0,
                    sourceEnd: 0.5,
                    timelineStart: 0
                  }
                ]
              }
            ],
            settings: { frameRate: 30 }
          })
        }).then(async (res) => {
          assert(res.status === 200, `Concurrent PUT #${idx} returned 200`);
          return (await res.json()) as { data: { id: string; createdAt: string } };
        })
      );

      const concurrentResults = await Promise.all(concurrentRequests);
      for (const res of concurrentResults) {
        assert(
          res.data.id === initialTimelineId,
          "Stable timeline ID preserved under concurrent updates"
        );
        assert(
          res.data.createdAt === initialCreatedAt,
          "Original createdAt preserved under concurrent updates"
        );
      }

      // Verify exactly one timeline document exists in MongoDB collection
      const timelinesCol = getDB().collection("timelines");
      const timelineCount = await timelinesCol.countDocuments({ projectId });
      assert(timelineCount === 1, "Exactly one timeline document exists for project in MongoDB Atlas");

      // ----------------------------------------------------
      // 25. Render Plan Generation & Dry-Run Validation API
      // ----------------------------------------------------
      console.log("\n[Test 25] Render Plan Generation & Dry-Run Validation API");
      const planRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      assert(planRes.status === 200, "POST /api/projects/:id/render/plan returns 200 OK");
      const planJson = (await planRes.json()) as any;
      assert(planJson.data?.plan?.projectId === projectId, "Render plan belongs to target project");
      assert(planJson.data?.plan?.videoClips?.length > 0, "Render plan contains video clips");
      assert(planJson.data?.validation?.valid === true, "Render plan is validated successfully");
      assert(planJson.data?.plan?.output?.format === "mp4", "Output format defaults to mp4");
      assert(planJson.data?.plan?.settings?.width === 1920, "Settings width matches timeline settings");
      assert(!JSON.stringify(planJson).includes(os.homedir()), "API response strictly hides internal filesystem paths");

      // Verify rejection of multi-track video compositing when 2 enabled video tracks overlap
      const multiVideoOverlapTl = {
        id: "tl_multi_v",
        projectId,
        tracks: [
          {
            id: "tr_v1",
            name: "Video 1",
            type: "video",
            index: 0,
            enabled: true,
            clips: [
              {
                id: "cl_v1",
                assetId: validAssetId,
                trackId: "tr_v1",
                sourceStart: 0,
                sourceEnd: 0.8,
                timelineStart: 0
              }
            ]
          },
          {
            id: "tr_v2",
            name: "Video 2",
            type: "video",
            index: 1,
            enabled: true,
            clips: [
              {
                id: "cl_v2",
                assetId: validAssetId,
                trackId: "tr_v2",
                sourceStart: 0,
                sourceEnd: 0.8,
                timelineStart: 0.3 // Overlaps [0, 0.8]
              }
            ]
          }
        ],
        settings: { frameRate: 30, width: 1920, height: 1080 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const multiVRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline: multiVideoOverlapTl })
      });
      const multiVJson = (await multiVRes.json()) as any;
      assert(multiVJson.data?.validation?.valid === false, "Overlapping multi-track video is rejected");
      assert(
        multiVJson.data?.validation?.errors?.some((e: string) => e.includes("Multi-track video compositing is not yet supported")),
        "Rejection error explicitly specifies unsupported multi-track video compositing"
      );

      // Verify disabled overlapping video track is excluded and passes validation
      const multiVDisabledTl = {
        ...multiVideoOverlapTl,
        tracks: [
          multiVideoOverlapTl.tracks[0],
          { ...multiVideoOverlapTl.tracks[1], enabled: false }
        ]
      };
      const multiVDisRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline: multiVDisabledTl })
      });
      const multiVDisJson = (await multiVDisRes.json()) as any;
      assert(multiVDisJson.data?.validation?.valid === true, "Disabled overlapping video track is excluded and passes");

      // ----------------------------------------------------
      // 26. Reject Render Plan with Nonexistent Media Asset Reference
      // ----------------------------------------------------
      console.log("\n[Test 26] Reject Render Plan with Nonexistent Media Asset Reference");
      const fakeAssetTimeline = {
        id: "tl_fake",
        projectId,
        tracks: [
          {
            id: "tr_fake",
            name: "Video 1",
            type: "video",
            index: 0,
            enabled: true,
            clips: [
              {
                id: "cl_fake",
                assetId: new ObjectId().toHexString(),
                trackId: "tr_fake",
                sourceStart: 0,
                sourceEnd: 5,
                timelineStart: 0
              }
            ]
          }
        ],
        settings: { frameRate: 30, width: 1920, height: 1080 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const badAssetRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline: fakeAssetTimeline })
      });
      assert(badAssetRes.status === 200, "POST /api/projects/:id/render/plan returns 200 with diagnostics");
      const badAssetJson = (await badAssetRes.json()) as any;
      assert(badAssetJson.data?.validation?.valid === false, "Validation reports valid: false for missing asset");
      assert(
        badAssetJson.data?.validation?.errors?.some((e: string) => e.includes("does not exist in project")),
        "Error message explicitly identifies missing asset in project"
      );

      // ----------------------------------------------------
      // 27. Reject Cross-Project Asset Hijacking in Render Plan
      // ----------------------------------------------------
      console.log("\n[Test 27] Reject Cross-Project Asset Hijacking in Render Plan");
      const crossProjectTimeline = {
        id: "tl_cross",
        projectId,
        tracks: [
          {
            id: "tr_cross",
            name: "Video 1",
            type: "video",
            index: 0,
            enabled: true,
            clips: [
              {
                id: "cl_cross",
                assetId: validAssetId, // Belongs to projectId
                trackId: "tr_cross",
                sourceStart: 0,
                sourceEnd: 5,
                timelineStart: 0
              }
            ]
          }
        ],
        settings: { frameRate: 30, width: 1920, height: 1080 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      // Attempt to validate this timeline under project2Id (which does not own validAssetId)
      const crossRenderRes = await fetch(`${baseUrl}/api/projects/${project2Id}/render/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline: { ...crossProjectTimeline, projectId: project2Id } })
      });
      assert(crossRenderRes.status === 200, "Cross-project check returns 200 with validation diagnosis");
      const crossRenderJson = (await crossRenderRes.json()) as any;
      assert(crossRenderJson.data?.validation?.valid === false, "Cross-project asset reference is rejected");
      assert(
        crossRenderJson.data?.validation?.errors?.some((e: string) => e.includes("belongs to another project") || e.includes("does not exist in project")),
        "Diagnostic error identifies cross-project media violation"
      );

      // ----------------------------------------------------
      // 28. Reject Missing Physical Media File on Disk
      // ----------------------------------------------------
      console.log("\n[Test 28] Reject Missing Physical Media File on Disk");
      const mediaAssetsCol28 = getDB().collection("media_assets");
      const ghostAssetId = new ObjectId();
      await mediaAssetsCol28.insertOne({
        _id: ghostAssetId,
        projectId,
        originalName: "ghost.mp4",
        storedFileName: "nonexistent_ghost_file.mp4",
        fileSize: 1024,
        mimeType: "video/mp4",
        duration: 10.0,
        width: 1920,
        height: 1080,
        frameRate: "30",
        videoCodec: "h264",
        audioCodec: "aac",
        format: "mov,mp4,m4a,3gp,3g2,mj2",
        createdAt: new Date()
      });
      const ghostTimeline = {
        id: "tl_ghost",
        projectId,
        tracks: [
          {
            id: "tr_ghost",
            name: "Video",
            type: "video",
            index: 0,
            enabled: true,
            clips: [
              {
                id: "cl_ghost",
                assetId: ghostAssetId.toHexString(),
                trackId: "tr_ghost",
                sourceStart: 0,
                sourceEnd: 5,
                timelineStart: 0
              }
            ]
          }
        ],
        settings: { frameRate: 30, width: 1920, height: 1080 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const ghostRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline: ghostTimeline })
      });
      const ghostJson = (await ghostRes.json()) as any;
      assert(ghostJson.data?.validation?.valid === false, "Missing physical media file on disk rejected");
      assert(
        ghostJson.data?.validation?.errors?.some((e: string) => e.includes("missing on disk")),
        "Error message explicitly identifies missing disk file"
      );
      // Clean up ghost asset doc
      await mediaAssetsCol28.deleteOne({ _id: ghostAssetId });

      // ----------------------------------------------------
      // 29. Create Render Job & Enqueue State in MongoDB
      // ----------------------------------------------------
      console.log("\n[Test 29] Create Render Job & Enqueue State in MongoDB");
      const createJobRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      assert(createJobRes.status === 201, "POST /api/projects/:id/render/jobs returns 201 Created");
      const jobJson = (await createJobRes.json()) as any;
      const createdJob = jobJson.data;
      assert(Boolean(createdJob.id), "Render job has valid jobId");
      assert(createdJob.status === "queued", "Initial render job status is strictly 'queued'");
      assert(createdJob.progress === 0, "Initial render job progress is 0");
      assert(createdJob.projectId === projectId, "Job belongs to correct project");
      assert(createdJob.plan?.videoClips?.length > 0, "Job stores validated render plan");

      // Verify job was persisted in MongoDB
      const renderJobsCol = getDB().collection("render_jobs");
      const jobInDb = await renderJobsCol.findOne({ jobId: createdJob.id });
      assert(Boolean(jobInDb), "Render job document persisted durably in MongoDB Atlas");
      assert(["queued", "validating", "rendering"].includes(jobInDb?.status || ""), "Persisted DB status is in valid state");

      // Verify retrieving single job via GET endpoint
      const getJobRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/jobs/${createdJob.id}`);
      assert(getJobRes.status === 200, "GET /api/projects/:id/render/jobs/:jobId returns 200 OK");
      const getJobJson = (await getJobRes.json()) as any;
      assert(getJobJson.data?.id === createdJob.id, "Retrieved job ID matches created job");
      assert(["queued", "validating", "rendering"].includes(getJobJson.data?.status), "Retrieved job status is in valid active state");

      // Verify listing jobs for project
      const listJobsRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/jobs`);
      assert(listJobsRes.status === 200, "GET /api/projects/:id/render/jobs returns 200 OK");
      const listJobsJson = (await listJobsRes.json()) as any;
      assert(Array.isArray(listJobsJson.data), "List render jobs returns array");
      assert(
        listJobsJson.data.some((j: any) => j.id === createdJob.id),
        "Created render job appears in project jobs list"
      );

      // Verify FFmpeg binary safety checks and export directory
      const ffmpegPath = getFFmpegPath();
      assert(Boolean(ffmpegPath), "getFFmpegPath returns configured or default path");

      // Verify checkFFmpegAvailable handles invalid / missing paths cleanly without crashing
      const missingBinAvailable = await checkFFmpegAvailable("C:\\nonexistent\\missing_fake_ffmpeg.exe");
      assert(missingBinAvailable === false, "checkFFmpegAvailable cleanly returns false for missing binary");

      // Verify validateFFmpegSafety blocks shell injection tokens
      let injectionBlocked = false;
      try {
        validateFFmpegSafety(["-i", "input.mp4; rm -rf /", "-c:v", "copy"]);
      } catch {
        injectionBlocked = true;
      }
      assert(injectionBlocked === true, "validateFFmpegSafety detects and blocks shell control characters");

      const exportDir = getProjectExportDir(projectId);
      assert(fs.existsSync(exportDir), "AgentCut-managed export directory created safely");
      const exportFilePath = resolveExportFilePath(projectId, "render_test.mp4");
      assert(exportFilePath.startsWith(exportDir), "resolveExportFilePath strictly enforces directory boundaries");

      // ----------------------------------------------------
      // 30. Render Job Cancellation & Safety Boundaries
      // ----------------------------------------------------
      console.log("\n[Test 30] Render Job Cancellation & Safety Boundaries");
      const cancelRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/render/jobs/${createdJob.id}/cancel`,
        { method: "POST" }
      );
      assert(cancelRes.status === 200, "POST /api/projects/:id/render/jobs/:jobId/cancel returns 200 OK");
      const cancelJson = (await cancelRes.json()) as any;
      assert(cancelJson.data?.status === "canceled", "Canceled job status updated to 'canceled'");

      // Verify DB reflects canceled status
      const canceledInDb = await renderJobsCol.findOne({ jobId: createdJob.id });
      assert(canceledInDb?.status === "canceled", "MongoDB record reflects 'canceled' status");

      // Reject render job creation on project with no timeline
      const noTlProjRes = await fetch(`${baseUrl}/api/projects/${project2Id}/render/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      assert(noTlProjRes.status === 500 || noTlProjRes.status === 400, "Reject render job on project with no timeline");

      // ----------------------------------------------------
      // 31. FFmpeg Argument Construction & Filtergraph Generation
      // ----------------------------------------------------
      console.log("\n[Test 31] FFmpeg Argument Construction & Filtergraph Generation");
      const mockResolvedPlan = {
        projectId,
        timelineId: "tl_mock",
        settings: { width: 320, height: 240, frameRate: 30 },
        duration: 2.0,
        videoClips: [
          {
            clipId: "c_v1",
            assetId: "a1",
            trackId: "tr_v",
            trackType: "video" as const,
            sourceStart: 0,
            sourceEnd: 0.8,
            timelineStart: 0.5,
            duration: 0.8,
            timelineEnd: 1.3,
            resolvedFilePath: validMp4Path,
            hasAudio: true
          }
        ],
        audioClips: [
          {
            clipId: "c_a1",
            assetId: "a2",
            trackId: "tr_a",
            trackType: "audio" as const,
            sourceStart: 0,
            sourceEnd: 0.8,
            timelineStart: 0.5,
            duration: 0.8,
            timelineEnd: 1.3,
            resolvedFilePath: validMp4Path,
            hasAudio: true
          }
        ],
        tracks: [],
        output: {
          format: "mp4" as const,
          videoCodec: "libx264" as const,
          audioCodec: "aac" as const,
          pixelFormat: "yuv420p" as const
        },
        createdAt: new Date().toISOString()
      };

      const mockTmpOutput = resolveExportFilePath(projectId, "mock_test.tmp.mp4");
      const builtArgs = buildFFmpegRenderArgs(mockResolvedPlan, mockTmpOutput);
      assert(builtArgs.includes("-filter_complex"), "Arguments include -filter_complex flag");
      assert(builtArgs.includes("-map"), "Arguments include -map flags");
      assert(builtArgs.includes("[outv]"), "Arguments map [outv]");
      assert(builtArgs.includes("[outa]"), "Arguments map [outa]");
      assert(builtArgs.includes("libx264"), "Arguments specify libx264 codec");
      assert(builtArgs.includes("yuv420p"), "Arguments specify yuv420p pixel format");
      assert(builtArgs.includes("aac"), "Arguments specify aac audio codec");

      const filterComplexArg = builtArgs[builtArgs.indexOf("-filter_complex") + 1];
      assert(filterComplexArg.includes("color=c=black"), "Filter complex generates black video for leading/trailing gaps");
      assert(filterComplexArg.includes("trim=start=0.0000:end=0.8000"), "Filter complex generates trim filter for clip");
      assert(filterComplexArg.includes("scale=320:240"), "Filter complex scales video to plan dimensions");
      assert(filterComplexArg.includes("anullsrc="), "Filter complex generates silence for audio gaps");
      assert(filterComplexArg.includes("concat=n=3:v=1:a=0"), "Filter complex concats 3 video segments");
      assert(filterComplexArg.includes("concat=n=3:v=0:a=1"), "Filter complex concats 3 audio segments");

      // Verify built arguments pass strict security validation without throwing
      let builtArgsSafe = true;
      try {
        validateFFmpegSafety(builtArgs);
      } catch {
        builtArgsSafe = false;
      }
      assert(builtArgsSafe, "FFmpeg argument array strictly passes validateFFmpegSafety");

      // ----------------------------------------------------
      // 32. Execution of MP4 Rendering with FFmpeg, Progress Tracking & Verification
      // ----------------------------------------------------
      console.log("\n[Test 32] MP4 Rendering Execution, Progress Tracking & Output Verification");
      const renderStartRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      assert(renderStartRes.status === 201, "POST /api/projects/:id/render/jobs returns 201 Created");
      const startJobData = ((await renderStartRes.json()) as any).data;
      const executionJobId = startJobData.id;

      // Poll until the background rendering job finishes (timeout 25 seconds)
      let finalExecutionJob: any = null;
      const pollStartTime = Date.now();
      while (Date.now() - pollStartTime < 25000) {
        await new Promise((r) => setTimeout(r, 400));
        const pollRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/jobs/${executionJobId}`);
        const pollJson = (await pollRes.json()) as any;
        const currentStatus = pollJson.data?.status;
        if (currentStatus === "completed" || currentStatus === "failed" || currentStatus === "canceled") {
          finalExecutionJob = pollJson.data;
          break;
        }
      }

      assert(Boolean(finalExecutionJob), "Render job finished within timeout");
      assert(finalExecutionJob?.status === "completed", `Render job status is 'completed' (was: ${finalExecutionJob?.status}, error: ${finalExecutionJob?.error})`);
      assert(finalExecutionJob?.progress === 100, "Completed render job progress is 100%");
      assert(Boolean(finalExecutionJob?.outputMetadata?.outputFileName), "Output metadata contains outputFileName");
      assert(Boolean(finalExecutionJob?.outputMetadata?.fileSizeBytes && finalExecutionJob.outputMetadata.fileSizeBytes > 0), "Output file size > 0 bytes");

      const finalRenderFilePath = resolveExportFilePath(projectId, finalExecutionJob.outputMetadata.outputFileName);
      assert(fs.existsSync(finalRenderFilePath), "Rendered MP4 file exists at final path on disk");

      const tmpRenderFilePath = resolveExportFilePath(projectId, `render_${executionJobId}.tmp.mp4`);
      assert(!fs.existsSync(tmpRenderFilePath), "Temporary file (.tmp.mp4) was removed upon completion");

      // Inspect completed MP4 with FFprobe
      const outputInspection = await inspectVideo(finalRenderFilePath);
      assert(outputInspection.videoCodec === "h264", "Rendered MP4 video codec is h264");
      assert(outputInspection.width === 1920, "Rendered MP4 width matches settings (1920)");
      assert(outputInspection.height === 1080, "Rendered MP4 height matches settings (1080)");
      assert(outputInspection.audioCodec === "aac", "Rendered MP4 contains AAC audio stream");
      assert(outputInspection.duration > 0, "Rendered MP4 duration is > 0s");

      // ----------------------------------------------------
      // 33. Cancellation of Render Job & Temp File Cleanup
      // ----------------------------------------------------
      console.log("\n[Test 33] Cancellation of Render Job & Temp File Cleanup");
      const cancelJobRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const cancelJobId = ((await cancelJobRes.json()) as any).data.id;

      // Cancel the job
      const postCancelRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/render/jobs/${cancelJobId}/cancel`,
        { method: "POST" }
      );
      assert(postCancelRes.status === 200, "POST cancel returns 200 OK");
      const postCancelJson = (await postCancelRes.json()) as any;
      assert(postCancelJson.data?.status === "canceled", "Canceled job has status 'canceled'");

      // Verify no temporary file was left behind
      const cancelTmpPath = resolveExportFilePath(projectId, `render_${cancelJobId}.tmp.mp4`);
      assert(!fs.existsSync(cancelTmpPath), "Temporary render file was cleaned up on cancellation");

      // ----------------------------------------------------
      // 34. Duplicate Concurrent Execution Prevention
      // ----------------------------------------------------
      console.log("\n[Test 34] Duplicate Concurrent Execution Prevention");
      assert(isJobActive("nonexistent_fake_job") === false, "isJobActive returns false for inactive jobs");
      const duplicateExecResult = await executeRenderJob(finalExecutionJob.id);
      assert(duplicateExecResult === null, "executeRenderJob on completed job returns null without re-executing");

      // ----------------------------------------------------
      // 35. Download Endpoint Authorization & Streaming
      // ----------------------------------------------------
      console.log("\n[Test 35] Download Endpoint Authorization & Streaming");
      const downloadRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/render/jobs/${executionJobId}/download`
      );
      assert(downloadRes.status === 200, "GET /api/projects/:id/render/jobs/:jobId/download returns 200 OK");
      assert(downloadRes.headers.get("content-type") === "video/mp4", "Content-Type is 'video/mp4'");
      assert(
        Boolean(downloadRes.headers.get("content-disposition")?.includes("attachment")),
        "Content-Disposition specifies attachment"
      );
      const downloadBuf = await downloadRes.arrayBuffer();
      assert(downloadBuf.byteLength > 0, "Downloaded stream contains file bytes");

      // Reject download of canceled job
      const cancelDownloadRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/render/jobs/${cancelJobId}/download`
      );
      assert(cancelDownloadRes.status === 400, "Reject download of non-completed job with 400 Bad Request");

      // Reject download of nonexistent job
      const missingDownloadRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/render/jobs/missing_job_123/download`
      );
      assert(missingDownloadRes.status === 404, "Reject download of nonexistent job with 404");

      // Reject cross-project unauthorized download attempt
      const crossDownloadRes = await fetch(
        `${baseUrl}/api/projects/${project2Id}/render/jobs/${executionJobId}/download`
      );
      assert(crossDownloadRes.status === 404, "Cross-project download attempt returns 404");

      // ----------------------------------------------------
      // 36. Real Project Rendering & Verification (Project: 6af851b5d8c9874f24593e12)
      // ----------------------------------------------------
      console.log("\n[Test 36] Real Project Rendering & Verification (6af851b5d8c9874f24593e12)");
      const realProjId = "6af851b5d8c9874f24593e12";
      const realProjCheck = await fetch(`${baseUrl}/api/projects/${realProjId}`);
      if (realProjCheck.status === 200) {
        // Save a fast 2-second clip timeline on real project
        const tlGetRes = await fetch(`${baseUrl}/api/projects/${realProjId}/timeline`);
        const originalRealTl = ((await tlGetRes.json()) as any).data;

        const fastTestTl = {
          ...originalRealTl,
          tracks: [
            {
              ...originalRealTl.tracks[0],
              clips: [
                {
                  ...originalRealTl.tracks[0].clips[0],
                  sourceStart: 0,
                  sourceEnd: 2.0,
                  timelineStart: 0
                }
              ]
            }
          ]
        };

        // Save fast timeline
        await fetch(`${baseUrl}/api/projects/${realProjId}/timeline`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fastTestTl)
        });

        // Trigger render
        const realRenderRes = await fetch(`${baseUrl}/api/projects/${realProjId}/render/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        assert(realRenderRes.status === 201, "Real project render job enqueued with 201");
        const realJobId = ((await realRenderRes.json()) as any).data.id;

        // Poll for completion (timeout 30s)
        let completedRealJob: any = null;
        const realPollStart = Date.now();
        while (Date.now() - realPollStart < 30000) {
          await new Promise((r) => setTimeout(r, 500));
          const rRes = await fetch(`${baseUrl}/api/projects/${realProjId}/render/jobs/${realJobId}`);
          const rJson = (await rRes.json()) as any;
          if (rJson.data?.status === "completed" || rJson.data?.status === "failed") {
            completedRealJob = rJson.data;
            break;
          }
        }

        assert(completedRealJob?.status === "completed", `Real project render finished with 'completed' status (was: ${completedRealJob?.status})`);
        const realOutFile = resolveExportFilePath(realProjId, completedRealJob.outputMetadata.outputFileName);
        assert(fs.existsSync(realOutFile), "Real project rendered MP4 exists on filesystem");

        // Inspect output MP4 with FFprobe
        const realInspect = await inspectVideo(realOutFile);
        assert(realInspect.width === 1920, "Real project MP4 width is 1920");
        assert(realInspect.height === 1080, "Real project MP4 height is 1080");
        assert(realInspect.videoCodec === "h264", "Real project MP4 video codec is h264");
        assert(realInspect.audioCodec === "aac", "Real project MP4 audio codec is aac");
        assert(Math.abs(realInspect.duration - 2.0) <= 0.5, "Real project MP4 duration matches (2.0s)");

        // Test download endpoint for real project
        const realDownloadRes = await fetch(`${baseUrl}/api/projects/${realProjId}/render/jobs/${realJobId}/download`);
        assert(realDownloadRes.status === 200, "Download endpoint for real project returns 200 OK");
        assert(realDownloadRes.headers.get("content-type") === "video/mp4", "Real project download content-type is video/mp4");

        // Restore original 30s timeline
        await fetch(`${baseUrl}/api/projects/${realProjId}/timeline`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(originalRealTl)
        });

        // Verify original source video file remains 100% intact
        const realMediaDir = getProjectMediaDir(realProjId);
        const realMediaFiles = fs.readdirSync(realMediaDir);
        const realMediaFile = path.join(realMediaDir, realMediaFiles[0]);
        const realStat = fs.statSync(realMediaFile);
        assert(realStat.size === 630675104, "CRITICAL: Real project source media file intact (630675104 bytes)");
      } else {
        console.log("  - Skipped: Real project 6af851b5d8c9874f24593e12 not found in current environment");
      }

      // ----------------------------------------------------
      // 37. Audio Extraction Foundation (Step 5.1)
      // ----------------------------------------------------
      console.log("\n[Test 37] Audio Extraction Foundation (Step 5.1)");
      const audioExtractionsCol = getDB().collection("audio_extractions");
      const mediaAssetsCol = getDB().collection("media_assets");

      function getFileSha256(filePath: string): string {
        const data = fs.readFileSync(filePath);
        return crypto.createHash("sha256").update(data).digest("hex");
      }

      // 37.1 Upload synthetic video with audio
      const formDataWithAudio = new FormData();
      formDataWithAudio.append("file", new Blob([fs.readFileSync(videoWithAudioPath)]), "video_with_audio.mp4");
      const uploadWithAudioRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: formDataWithAudio
      });
      assert(uploadWithAudioRes.status === 201, "Uploaded video with audio successfully");
      const assetWithAudio = ((await uploadWithAudioRes.json()) as any).data;
      const assetWithAudioId = assetWithAudio.id;

      // Also get physical path on disk for source immutability check
      const assetWithAudioDoc = await mediaAssetsCol.findOne({ _id: new ObjectId(assetWithAudioId) });
      const assetWithAudioPath = resolveStoredFilePath(projectId, assetWithAudioDoc!.storedFileName);
      const sourceSizeBefore = fs.statSync(assetWithAudioPath).size;
      const sourceShaBefore = getFileSha256(assetWithAudioPath);

      // 37.2 Request audio extraction
      const extractRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${assetWithAudioId}/audio/extract`,
        { method: "POST" }
      );
      assert(extractRes.status === 200, "POST audio/extract returns 200 OK");
      const extractData = ((await extractRes.json()) as any).data;

      assert(extractData.status === "completed", "Audio extraction status is 'completed'");
      assert(extractData.projectId === projectId, "Extraction artifact matches projectId");
      assert(extractData.assetId === assetWithAudioId, "Extraction artifact matches assetId");
      assert(extractData.audioProperties?.format === "wav", "Audio format is 'wav'");
      assert(extractData.audioProperties?.codec === "pcm_s16le", "Audio codec is 'pcm_s16le'");
      assert(extractData.audioProperties?.sampleRate === 16000, "Audio sample rate is 16000 Hz");
      assert(extractData.audioProperties?.channels === 1, "Audio is mono (1 channel)");
      assert(extractData.audioProperties?.bitDepth === 16, "Audio bit depth is 16-bit");
      assert(extractData.audioProperties?.duration >= 1.8, "Audio duration is valid (~2s)");
      assert(extractData.artifactSize > 0, "Artifact size is > 0 bytes");
      assert(Boolean(extractData.completedAt), "completedAt timestamp is recorded");

      // Verify no server paths are exposed to client
      const rawPayload = JSON.stringify(extractData);
      assert(!rawPayload.includes("C:\\") && !rawPayload.includes("/Users/") && !extractData.resolvedPath, "Client response never exposes server filesystem paths");

      // 37.3 Verify physical audio.wav on disk
      const expectedWavPath = resolveAssetAnalysisAudioPath(projectId, assetWithAudioId);
      assert(fs.existsSync(expectedWavPath), "Extracted audio.wav exists on disk at expected analysis path");
      const tempWavPath = resolveAssetAnalysisTempAudioPath(projectId, assetWithAudioId);
      assert(!fs.existsSync(tempWavPath), "Temporary audio.tmp.wav was cleaned up upon completion");

      // Verify audio properties directly with FFprobe
      const inspectedWav = await inspectAudioFile(expectedWavPath);
      assert(inspectedWav.codec === "pcm_s16le", "FFprobe verifies output codec is pcm_s16le");
      assert(inspectedWav.sampleRate === 16000, "FFprobe verifies output sample rate is 16000 Hz");
      assert(inspectedWav.channels === 1, "FFprobe verifies output is mono (1 channel)");
      assert(inspectedWav.format === "wav", "FFprobe verifies output format is wav");

      // 37.4 Source media preservation
      const sourceSizeAfter = fs.statSync(assetWithAudioPath).size;
      const sourceShaAfter = getFileSha256(assetWithAudioPath);
      assert(sourceSizeBefore === sourceSizeAfter, "CRITICAL: Source video file size is 100% unchanged after extraction");
      assert(sourceShaBefore === sourceShaAfter, "CRITICAL: Source video SHA-256 checksum is 100% unchanged after extraction");

      // 37.5 Retrieve extraction status via GET
      const getStatusRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${assetWithAudioId}/audio`);
      assert(getStatusRes.status === 200, "GET /api/projects/:id/media/:assetId/audio returns 200 OK");
      const getStatusData = ((await getStatusRes.json()) as any).data;
      assert(getStatusData.status === "completed", "GET returns status 'completed'");
      assert(getStatusData.artifactSize === extractData.artifactSize, "GET artifact size matches");

      // 37.6 Stream extracted WAV via GET
      const streamWavRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${assetWithAudioId}/audio/stream`);
      assert(streamWavRes.status === 200, "GET /api/projects/:id/media/:assetId/audio/stream returns 200 OK");
      assert(streamWavRes.headers.get("content-type") === "audio/wav", "Stream Content-Type is audio/wav");
      const streamedBuf = await streamWavRes.arrayBuffer();
      assert(streamedBuf.byteLength === extractData.artifactSize, "Streamed audio length matches artifact size");

      // 37.7 Idempotency & Caching: Repeated request avoids re-running FFmpeg
      const repeatExtractRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${assetWithAudioId}/audio/extract`,
        { method: "POST" }
      );
      assert(repeatExtractRes.status === 200, "Repeated POST audio/extract returns 200 OK");
      const repeatData = ((await repeatExtractRes.json()) as any).data;
      assert(repeatData.completedAt === extractData.completedAt, "Repeated request returns cached extraction without re-running");

      // 37.8 Concurrency deduplication
      const [conc1, conc2] = await Promise.all([
        requestAudioExtraction(projectId, assetWithAudioId),
        requestAudioExtraction(projectId, assetWithAudioId)
      ]);
      assert(conc1.id === conc2.id, "Concurrent extraction calls return identical artifact");

      // 37.9 Video with no audio stream
      const formDataNoAudio = new FormData();
      formDataNoAudio.append("file", new Blob([fs.readFileSync(videoWithoutAudioPath)]), "video_no_audio.mp4");
      const uploadNoAudioRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: formDataNoAudio
      });
      assert(uploadNoAudioRes.status === 201, "Uploaded video without audio successfully");
      const assetNoAudio = ((await uploadNoAudioRes.json()) as any).data;
      const assetNoAudioId = assetNoAudio.id;

      const noAudioExtractRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${assetNoAudioId}/audio/extract`,
        { method: "POST" }
      );
      assert(noAudioExtractRes.status === 200, "Audio extraction on video without audio returns 200");
      const noAudioData = ((await noAudioExtractRes.json()) as any).data;
      assert(noAudioData.status === "no_audio", "Status is explicitly 'no_audio'");
      assert(noAudioData.error?.includes("does not contain an audio stream"), "Error explains media asset has no audio stream");
      const noAudioWavPath = resolveAssetAnalysisAudioPath(projectId, assetNoAudioId);
      assert(!fs.existsSync(noAudioWavPath), "No audio.wav was generated for video without audio");

      // 37.10 Missing source file handling
      const missingAssetId = new ObjectId().toHexString();
      await mediaAssetsCol.insertOne({
        _id: new ObjectId(missingAssetId),
        projectId,
        originalName: "ghost.mp4",
        storedFileName: "nonexistent-ghost-uuid.mp4",
        fileSize: 1000,
        mimeType: "video/mp4",
        duration: 1,
        width: 320,
        height: 240,
        frameRate: "30",
        videoCodec: "h264",
        audioCodec: "aac",
        format: "mp4",
        createdAt: new Date()
      });
      const missingExtractRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${missingAssetId}/audio/extract`,
        { method: "POST" }
      );
      assert(missingExtractRes.status === 404, "Extraction on missing source file returns 404");
      const missingDoc = await audioExtractionsCol.findOne({ projectId, assetId: missingAssetId });
      assert(missingDoc?.status === "failed", "MongoDB record reflects 'failed' status for missing file");
      assert(missingDoc?.error?.includes("not found on disk"), "MongoDB record error notes file not on disk");

      // 37.11 Corrupt source file handling & temp file cleanup
      const corruptFileName = `${new ObjectId().toHexString()}_corrupt.mp4`;
      const corruptFilePath = resolveStoredFilePath(projectId, corruptFileName);
      fs.writeFileSync(corruptFilePath, Buffer.from("NOT_A_VALID_VIDEO_FILE_AT_ALL_CORRUPT_DATA"));
      const corruptAssetId = new ObjectId().toHexString();
      await mediaAssetsCol.insertOne({
        _id: new ObjectId(corruptAssetId),
        projectId,
        originalName: "corrupt.mp4",
        storedFileName: corruptFileName,
        fileSize: 40,
        mimeType: "video/mp4",
        duration: 1,
        width: 320,
        height: 240,
        frameRate: "30",
        videoCodec: "h264",
        audioCodec: "aac",
        format: "mp4",
        createdAt: new Date()
      });

      const corruptExtractRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${corruptAssetId}/audio/extract`,
        { method: "POST" }
      );
      assert(corruptExtractRes.status === 500, "Extraction on corrupt file returns 500");
      const corruptDoc = await audioExtractionsCol.findOne({ projectId, assetId: corruptAssetId });
      assert(corruptDoc?.status === "failed", "MongoDB record reflects 'failed' status for corrupt media");
      const corruptTempPath = resolveAssetAnalysisTempAudioPath(projectId, corruptAssetId);
      assert(!fs.existsSync(corruptTempPath), "Temporary .tmp.wav cleaned up on corrupt extraction failure");
      try { if (fs.existsSync(corruptFilePath)) fs.unlinkSync(corruptFilePath); } catch {}

      // 37.12 Cross-project access rejection
      const crossExtractRes = await fetch(
        `${baseUrl}/api/projects/${project2Id}/media/${assetWithAudioId}/audio/extract`,
        { method: "POST" }
      );
      assert(crossExtractRes.status === 404, "Cross-project extraction returns 404 Not Found");

      const crossGetRes = await fetch(
        `${baseUrl}/api/projects/${project2Id}/media/${assetWithAudioId}/audio`
      );
      assert(crossGetRes.status === 404, "Cross-project GET status returns 404 Not Found");

      // 37.13 Cancellation & Active Process Cleanup
      assert(!isExtractionActive("nonexistent-asset"), "isExtractionActive returns false for idle asset");
      assert(!cancelActiveExtraction("nonexistent-asset"), "cancelActiveExtraction returns false for idle asset");

      // ----------------------------------------------------
      // 38. Silence Detection (Step 5.2)
      // ----------------------------------------------------
      console.log("\n[Test 38] Silence Detection (Step 5.2)");
      const silenceDetectionsCol = getDB().collection("silence_detections");

      // 38.1 Validation of parameters
      const defaultParams = validateSilenceDetectionParameters({});
      assert(defaultParams.noiseThresholdDb === -35, "Default noise threshold is -35 dB");
      assert(defaultParams.minDurationSeconds === 0.5, "Default minimum silence duration is 0.5s");

      // Reject invalid parameters via API
      const invalidThresholdRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${assetWithAudioId}/silence/detect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ noiseThresholdDb: 10 })
        }
      );
      assert(invalidThresholdRes.status === 400, "Reject noiseThresholdDb > 0 dB with 400 Bad Request");

      const invalidDurationRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${assetWithAudioId}/silence/detect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minDurationSeconds: 0 })
        }
      );
      assert(invalidDurationRes.status === 400, "Reject minDurationSeconds <= 0 with 400 Bad Request");

      // 38.2 Reject detection when audio extraction is missing
      const unextractedAssetId = new ObjectId().toHexString();
      await mediaAssetsCol.insertOne({
        _id: new ObjectId(unextractedAssetId),
        projectId,
        originalName: "unextracted.mp4",
        storedFileName: "unextracted.mp4",
        fileSize: 1000,
        mimeType: "video/mp4",
        duration: 2,
        width: 320,
        height: 240,
        frameRate: "30",
        videoCodec: "h264",
        audioCodec: "aac",
        format: "mp4",
        createdAt: new Date()
      });

      const unextractedRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${unextractedAssetId}/silence/detect`,
        { method: "POST" }
      );
      assert(unextractedRes.status === 400, "Reject silence detection on unextracted asset with 400");
      const unextractedJson = (await unextractedRes.json()) as any;
      assert(
        unextractedJson.error?.includes("extract audio before"),
        "Error instructs client to extract audio first"
      );

      // 38.3 Synthetic silence interval testing using FFmpeg
      async function setupSyntheticAssetWithAudio(
        name: string,
        ffmpegAudioFilterInputs: string[],
        filterComplex: string
      ): Promise<{ assetId: string; audioPath: string }> {
        const id = new ObjectId().toHexString();
        await mediaAssetsCol.insertOne({
          _id: new ObjectId(id),
          projectId,
          originalName: `${name}.mp4`,
          storedFileName: `${name}_video.mp4`,
          fileSize: 10000,
          mimeType: "video/mp4",
          duration: 3,
          width: 320,
          height: 240,
          frameRate: "30",
          videoCodec: "h264",
          audioCodec: "aac",
          format: "mp4",
          createdAt: new Date()
        });

        getAssetAnalysisDir(projectId, id);
        const targetWav = resolveAssetAnalysisAudioPath(projectId, id);

        const genArgs = [
          "-y",
          ...ffmpegAudioFilterInputs,
          "-filter_complex", filterComplex,
          "-map", "[outa]",
          "-c:a", "pcm_s16le",
          "-ar", "16000",
          "-ac", "1",
          "-f", "wav",
          targetWav
        ];
        spawnSync(ffmpegPath, genArgs, { stdio: "ignore" });

        const audioInfo = await inspectAudioFile(targetWav);

        await audioExtractionsCol.insertOne({
          _id: new ObjectId(),
          projectId,
          assetId: id,
          status: "completed",
          audioProperties: {
            format: "wav",
            codec: "pcm_s16le",
            sampleRate: 16000,
            channels: 1,
            bitDepth: 16,
            duration: audioInfo.duration
          },
          artifactSize: audioInfo.fileSize,
          completedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        });

        return { assetId: id, audioPath: targetWav };
      }

      // Case A: Silence at the beginning (1s silence + 1s tone = 2s)
      const silenceStartAsset = await setupSyntheticAssetWithAudio(
        "silence_start",
        [
          "-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=1:channel_layout=mono",
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1"
        ],
        "[0:a][1:a]concat=n=2:v=0:a=1[outa]"
      );
      const resStart = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceStartAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resStart.status === 200, "POST silence/detect for silence at beginning returns 200");
      const dataStart = ((await resStart.json()) as any).data;
      assert(dataStart.intervals.length === 1, "Detected exactly 1 silence interval at beginning");
      assert(dataStart.intervals[0].start === 0, "Silence start is at 0.0s");
      assert(Math.abs(dataStart.intervals[0].end - 1.0) <= 0.1, "Silence end is ~1.0s");
      assert(Math.abs(dataStart.intervals[0].duration - 1.0) <= 0.1, "Silence duration is ~1.0s");
      assert(dataStart.totalSilenceDuration > 0.9, "Total silence duration matches interval");

      // Case B: Silence in the middle (1s tone + 1s silence + 1s tone = 3s)
      const silenceMidAsset = await setupSyntheticAssetWithAudio(
        "silence_middle",
        [
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1",
          "-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=1:channel_layout=mono",
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1"
        ],
        "[0:a][1:a][2:a]concat=n=3:v=0:a=1[outa]"
      );
      const resMid = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resMid.status === 200, "POST silence/detect for silence in middle returns 200");
      const dataMid = ((await resMid.json()) as any).data;
      assert(dataMid.intervals.length === 1, "Detected exactly 1 silence interval in middle");
      assert(Math.abs(dataMid.intervals[0].start - 1.0) <= 0.1, "Silence start is ~1.0s");
      assert(Math.abs(dataMid.intervals[0].end - 2.0) <= 0.1, "Silence end is ~2.0s");
      assert(Math.abs(dataMid.intervals[0].duration - 1.0) <= 0.1, "Silence duration is ~1.0s");

      // Case C: Silence at the end (1s tone + 1s silence = 2s)
      const silenceEndAsset = await setupSyntheticAssetWithAudio(
        "silence_end",
        [
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1",
          "-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=1:channel_layout=mono"
        ],
        "[0:a][1:a]concat=n=2:v=0:a=1[outa]"
      );
      const resEnd = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceEndAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resEnd.status === 200, "POST silence/detect for silence at end returns 200");
      const dataEnd = ((await resEnd.json()) as any).data;
      assert(dataEnd.intervals.length === 1, "Detected exactly 1 silence interval at end");
      assert(Math.abs(dataEnd.intervals[0].start - 1.0) <= 0.1, "Silence start is ~1.0s");
      assert(Math.abs(dataEnd.intervals[0].end - 2.0) <= 0.1, "Silence end is clamped to audio duration (~2.0s)");

      // Case D: Multiple silence intervals (0.8s silence + 1s tone + 0.8s silence + 1s tone = 3.6s)
      const silenceMultiAsset = await setupSyntheticAssetWithAudio(
        "silence_multiple",
        [
          "-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=0.8:channel_layout=mono",
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1",
          "-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=0.8:channel_layout=mono",
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1"
        ],
        "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[outa]"
      );
      const resMulti = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMultiAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resMulti.status === 200, "POST silence/detect for multiple silences returns 200");
      const dataMulti = ((await resMulti.json()) as any).data;
      assert(dataMulti.intervals.length === 2, "Detected exactly 2 silence intervals");
      assert(dataMulti.intervals[0].start < dataMulti.intervals[1].start, "Intervals sorted chronologically");
      assert(dataMulti.intervals[0].end <= dataMulti.intervals[1].start, "Intervals do not overlap");

      // Case E: No silence detected (2s continuous tone)
      const noSilenceAsset = await setupSyntheticAssetWithAudio(
        "no_silence",
        [
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=2"
        ],
        "[0:a]anull[outa]"
      );
      const resNoSilence = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${noSilenceAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resNoSilence.status === 200, "POST silence/detect for tone returns 200");
      const dataNoSilence = ((await resNoSilence.json()) as any).data;
      assert(dataNoSilence.intervals.length === 0, "No silence detected in continuous tone");
      assert(dataNoSilence.totalSilenceDuration === 0, "Total silence duration is 0");

      // Case F: Silence shorter than configured minimum duration (0.25s silence when minDuration is 0.5s)
      const shortSilenceAsset = await setupSyntheticAssetWithAudio(
        "short_silence",
        [
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1",
          "-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=0.25:channel_layout=mono",
          "-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1"
        ],
        "[0:a][1:a][2:a]concat=n=3:v=0:a=1[outa]"
      );
      const resShort = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${shortSilenceAsset.assetId}/silence/detect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minDurationSeconds: 0.5 })
        }
      );
      assert(resShort.status === 200, "POST silence/detect for short silence returns 200");
      const dataShort = ((await resShort.json()) as any).data;
      assert(dataShort.intervals.length === 0, "Silence shorter than minDuration (0.25s < 0.5s) is filtered out");

      // 38.4 Idempotency & Cache reuse with unchanged parameters
      const resRepeat = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resRepeat.status === 200, "Repeated POST silence/detect returns 200 OK");
      const dataRepeat = ((await resRepeat.json()) as any).data;
      assert(dataRepeat.completedAt === dataMid.completedAt, "Cached result returned without re-running FFmpeg");

      // 38.5 Reanalysis with changed parameters
      const resReanalysis = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/silence/detect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ noiseThresholdDb: -50, minDurationSeconds: 0.8 })
        }
      );
      assert(resReanalysis.status === 200, "Reanalysis with modified parameters returns 200 OK");
      const dataReanalysis = ((await resReanalysis.json()) as any).data;
      assert(dataReanalysis.parameters.noiseThresholdDb === -50, "Updated parameter noiseThresholdDb persisted");
      assert(dataReanalysis.parameters.minDurationSeconds === 0.8, "Updated parameter minDurationSeconds persisted");

      // 38.6 Concurrency deduplication
      const [concA, concB] = await Promise.all([
        detectSilence(projectId, silenceMidAsset.assetId, { noiseThresholdDb: -30 }),
        detectSilence(projectId, silenceMidAsset.assetId, { noiseThresholdDb: -30 })
      ]);
      assert(concA.id === concB.id, "Concurrent detection calls return identical artifact");

      // 38.7 GET silence detection endpoint
      const resGetSilence = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/silence`
      );
      assert(resGetSilence.status === 200, "GET silence status returns 200 OK");
      const dataGetSilence = ((await resGetSilence.json()) as any).data;
      assert(dataGetSilence.status === "completed", "GET returned status 'completed'");
      const rawSilencePayload = JSON.stringify(dataGetSilence);
      assert(!rawSilencePayload.includes("C:\\") && !rawSilencePayload.includes("/Users/"), "Client response never exposes server filesystem paths");

      // 38.8 Missing WAV file on disk
      const missingWavAsset = await setupSyntheticAssetWithAudio(
        "missing_wav",
        ["-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1"],
        "[0:a]anull[outa]"
      );
      fs.unlinkSync(missingWavAsset.audioPath); // delete audio.wav
      const resMissingWav = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${missingWavAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resMissingWav.status === 400, "Missing physical WAV returns 400 Bad Request");

      // 38.9 Corrupt WAV file
      const corruptWavAsset = await setupSyntheticAssetWithAudio(
        "corrupt_wav",
        ["-f", "lavfi", "-i", "sine=sample_rate=16000:frequency=1000:duration=1"],
        "[0:a]anull[outa]"
      );
      fs.writeFileSync(corruptWavAsset.audioPath, Buffer.from("CORRUPT_NOT_A_VALID_WAV_HEADER_DATA"));
      const resCorruptWav = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${corruptWavAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resCorruptWav.status === 500, "Corrupt WAV execution returns 500");

      // 38.10 Cross-project access rejection
      const resCrossSilence = await fetch(
        `${baseUrl}/api/projects/${project2Id}/media/${silenceMidAsset.assetId}/silence/detect`,
        { method: "POST" }
      );
      assert(resCrossSilence.status === 404, "Cross-project silence detection returns 404 Not Found");

      const resCrossGetSilence = await fetch(
        `${baseUrl}/api/projects/${project2Id}/media/${silenceMidAsset.assetId}/silence`
      );
      assert(resCrossGetSilence.status === 404, "Cross-project GET silence returns 404 Not Found");

      // 38.11 Active detection status & cancellation
      assert(!isSilenceDetectionActive("nonexistent-asset"), "isSilenceDetectionActive returns false for idle asset");
      assert(!cancelActiveSilenceDetection("nonexistent-asset"), "cancelActiveSilenceDetection returns false for idle asset");

      // Test live cancellation on a running FFmpeg process
      const longCancelAsset = await setupSyntheticAssetWithAudio(
        "long_cancel",
        ["-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=30:channel_layout=mono"],
        "[0:a]anull[outa]"
      );
      const cancelDetectPromise = detectSilence(projectId, longCancelAsset.assetId, { noiseThresholdDb: -45 });

      // Wait for the async preparation to complete and FFmpeg process to become active
      let isActive = false;
      for (let i = 0; i < 100; i++) {
        if (isSilenceDetectionActive(longCancelAsset.assetId)) {
          isActive = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert(isActive, "isSilenceDetectionActive returns true while process is running");
      const wasCanceled = cancelActiveSilenceDetection(longCancelAsset.assetId);
      assert(wasCanceled, "cancelActiveSilenceDetection returns true when terminating active process");
      assert(!isSilenceDetectionActive(longCancelAsset.assetId), "isSilenceDetectionActive returns false immediately after cancellation");
      let cancelRejected = false;
      try {
        await cancelDetectPromise;
      } catch {
        cancelRejected = true;
      }
      assert(cancelRejected, "Active detection promise rejects when process is cancelled");

      // ----------------------------------------------------
      // 39. Multilingual Audio Transcription Foundation (Step 5.3)
      // ----------------------------------------------------
      console.log("\n[Test 39] Multilingual Audio Transcription Foundation (Step 5.3)");
      const transcriptionsCol = getDB().collection("transcriptions");

      // 39.1 Real Hardware & Library Capabilities Probing
      const probeRes = await probeWorkerHardware();
      assert(probeRes.success, "Real worker probeHardware returns success");
      assert(probeRes.cuda_available === true, "Probe detects NVIDIA CUDA is available on GTX 1650");
      assert(probeRes.cuda_device_count >= 1, "Probe reports at least 1 CUDA device");
      assert(probeRes.supported_compute_types_cuda.includes("int8_float16"), "CUDA supports memory-conscious 'int8_float16'");
      assert(probeRes.supported_compute_types_cpu.includes("int8"), "CPU supports fallback 'int8'");
      assert(Boolean(probeRes.faster_whisper_version), "Faster-Whisper version reported");
      assert(Boolean(probeRes.ctranslate2_version), "CTranslate2 version reported");

      // 39.2 Real Worker Ping / Pong over JSON Lines
      const pingRes = await sendRequestToWorker({ id: "ping-test-1", type: "ping" });
      assert(pingRes.type === "pong", "Worker ping returns pong over JSON Lines");
      assert(pingRes.success === true, "Ping response reports success: true");

      // 39.3 Parameter Validation
      const defaultTxParams = validateTranscriptionParameters({});
      assert(defaultTxParams.modelName === "small", "Default model is 'small'");
      assert(defaultTxParams.device === "auto", "Default device is 'auto'");

      // Reject invalid modelName via API
      const invalidModelRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelName: "large-v3" })
        }
      );
      assert(invalidModelRes.status === 400, "Reject invalid modelName with 400 Bad Request");

      // Reject invalid languageHint via API
      const invalidLangRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ languageHint: "invalid-long-code" })
        }
      );
      assert(invalidLangRes.status === 400, "Reject invalid languageHint with 400 Bad Request");

      // Reject invalid device via API
      const invalidDeviceRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device: "tpu" })
        }
      );
      assert(invalidDeviceRes.status === 400, "Reject invalid device with 400 Bad Request");

      // 39.4 Missing Audio Extraction Prerequisite Rejection
      const txUnextractedRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${unextractedAssetId}/transcription`,
        { method: "POST" }
      );
      assert(txUnextractedRes.status === 400, "Reject transcription on unextracted asset with 400");
      const txUnextractedJson = (await txUnextractedRes.json()) as any;
      assert(
        txUnextractedJson.error?.includes("extract audio before"),
        "Error instructs client to extract audio first"
      );

      // 39.5 Missing Physical WAV on Disk
      const resMissingTxWav = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${missingWavAsset.assetId}/transcription`,
        { method: "POST" }
      );
      assert(resMissingTxWav.status === 400, "Missing physical WAV returns 400 Bad Request for transcription");

      // 39.6 Transcript Data Validation Rules
      const validMockTranscript = {
        language: "en",
        language_probability: 0.985,
        duration: 3.0,
        segments: [
          { id: 0, start: 0.0, end: 1.5, text: "Hello world", words: [{ word: "Hello", start: 0.0, end: 0.7 }, { word: "world", start: 0.7, end: 1.5 }] },
          { id: 1, start: 1.5, end: 3.0, text: "AgentCut transcription test", words: [{ word: "AgentCut", start: 1.5, end: 2.2 }] }
        ],
        text: "Hello world AgentCut transcription test"
      };
      const validatedData = validateTranscriptData(validMockTranscript, 3.0);
      assert(validatedData.segments.length === 2, "validateTranscriptData accepts valid segments");

      // Reject negative start
      let threwNegative = false;
      try {
        validateTranscriptData({ segments: [{ id: 0, start: -1, end: 1, text: "bad" }] }, 3.0);
      } catch (err: any) {
        threwNegative = /invalid start timestamp/i.test(err?.message || "");
      }
      assert(threwNegative, "validateTranscriptData throws on negative start timestamp");

      // Reject end < start
      let threwEndBeforeStart = false;
      try {
        validateTranscriptData({ segments: [{ id: 0, start: 2.0, end: 1.0, text: "bad" }] }, 3.0);
      } catch (err: any) {
        threwEndBeforeStart = /invalid end timestamp/i.test(err?.message || "");
      }
      assert(threwEndBeforeStart, "validateTranscriptData throws when end < start");

      // Reject start exceeding duration
      let threwExceeds = false;
      try {
        validateTranscriptData({ segments: [{ id: 0, start: 10.0, end: 12.0, text: "bad" }] }, 3.0);
      } catch (err: any) {
        threwExceeds = /exceeds audio duration/i.test(err?.message || "");
      }
      assert(threwExceeds, "validateTranscriptData throws when start exceeds audio duration");

      // Reject end exceeding audio duration (exceeding tolerance)
      let threwEndExceeds = false;
      try {
        validateTranscriptData({ segments: [{ id: 0, start: 1.0, end: 5.0, text: "bad" }] }, 3.0);
      } catch (err: any) {
        threwEndExceeds = /end .* exceeds audio duration limit/i.test(err?.message || "");
      }
      assert(threwEndExceeds, "validateTranscriptData throws when end exceeds audio duration limit");

      // Reject non-finite timestamps
      let threwNonFinite = false;
      try {
        validateTranscriptData({ segments: [{ id: 0, start: Infinity, end: 2.0, text: "bad" }] }, 3.0);
      } catch (err: any) {
        threwNonFinite = /invalid start timestamp/i.test(err?.message || "");
      }
      assert(threwNonFinite, "validateTranscriptData throws when start timestamp is non-finite");

      // Reject segments not chronologically ordered
      let threwChronological = false;
      try {
        validateTranscriptData(
          {
            segments: [
              { id: 0, start: 2.0, end: 2.5, text: "first" },
              { id: 1, start: 1.0, end: 1.5, text: "second" }
            ]
          },
          3.0
        );
      } catch (err: any) {
        threwChronological = /chronologically ordered/i.test(err?.message || "");
      }
      assert(threwChronological, "validateTranscriptData throws when segments are not chronologically ordered");

      // Reject word timestamp exceeding parent segment bounds
      let threwWordOutOfBounds = false;
      try {
        validateTranscriptData(
          {
            segments: [
              {
                id: 0,
                start: 1.0,
                end: 2.0,
                text: "hello",
                words: [{ word: "hello", start: 0.1, end: 2.9 }]
              }
            ]
          },
          3.0
        );
      } catch (err: any) {
        threwWordOutOfBounds = /exceeds parent segment boundaries/i.test(err?.message || "");
      }
      assert(threwWordOutOfBounds, "validateTranscriptData throws when word timestamp exceeds parent segment boundaries");

      // 39.7 Lifecycle & Atomic Artifact Persistence with Deterministic Mock Handler
      setMockWorkerHandler(async (req) => {
        if (req.type === "transcribe") {
          return {
            id: req.id,
            type: "transcribe",
            success: true,
            language: req.language || "en",
            language_probability: 0.99,
            duration: 3.0,
            segment_count: 2,
            segments: [
              {
                id: 0,
                start: 0.0,
                end: 0.8,
                text: "AgentCut video intelligence foundation.",
                words: [
                  { word: "AgentCut", start: 0.0, end: 0.3, probability: 0.99 },
                  { word: "video", start: 0.3, end: 0.5, probability: 0.98 },
                  { word: "intelligence", start: 0.5, end: 0.7, probability: 0.97 },
                  { word: "foundation", start: 0.7, end: 0.8, probability: 0.99 }
                ]
              },
              {
                id: 1,
                start: 0.9,
                end: 1.8,
                text: "Local multilingual transcription.",
                words: [
                  { word: "Local", start: 0.9, end: 1.2, probability: 0.98 },
                  { word: "multilingual", start: 1.2, end: 1.5, probability: 0.97 },
                  { word: "transcription", start: 1.5, end: 1.8, probability: 0.99 }
                ]
              }
            ],
            text: "AgentCut video intelligence foundation. Local multilingual transcription.",
            execution_device: req.device === "cpu" ? "cpu" : "cuda",
            compute_type: req.device === "cpu" ? "int8" : "int8_float16",
            model_name: req.model_name || "small"
          };
        }
        return null;
      });

      const txRes1 = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelName: "small" })
        }
      );
      assert(txRes1.status === 200, "POST transcription returns 200 OK");
      const txData1 = ((await txRes1.json()) as any).data;
      assert(txData1.status === "completed", "Transcription status transitions to 'completed'");
      assert(txData1.segmentCount === 2, "Transcription artifact reports segmentCount = 2");
      assert(txData1.detectedLanguage === "en", "Detected language is 'en'");
      assert(txData1.executionDevice === "cuda", "Execution device recorded as 'cuda'");
      assert(txData1.computeType === "int8_float16", "Compute type recorded as 'int8_float16'");

      // Verify physical transcript artifact exists on disk
      const transcriptDiskPath = resolveAssetTranscriptPath(projectId, silenceMidAsset.assetId);
      assert(fs.existsSync(transcriptDiskPath), "Atomic transcript.json persisted at expected analysis path");
      const parsedTranscriptDisk = JSON.parse(fs.readFileSync(transcriptDiskPath, "utf-8"));
      assert(parsedTranscriptDisk.segments.length === 2, "Persisted transcript.json contains valid segments");

      // 39.8 Hindi Language Hint Test
      const txHindiRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceStartAsset.assetId}/transcription`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelName: "small", languageHint: "hi" })
        }
      );
      assert(txHindiRes.status === 200, "POST transcription with Hindi hint returns 200 OK");
      const txHindiData = ((await txHindiRes.json()) as any).data;
      assert(txHindiData.parameters.languageHint === "hi", "Persisted languageHint is 'hi'");

      // 39.9 Concurrency Deduplication
      const [concTxA, concTxB] = await Promise.all([
        requestTranscription(projectId, silenceEndAsset.assetId, { modelName: "small" }),
        requestTranscription(projectId, silenceEndAsset.assetId, { modelName: "small" })
      ]);
      assert(concTxA.id === concTxB.id, "Concurrent transcription calls return identical artifact");

      // 39.10 Idempotency & Cache Reuse
      const txRepeatRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelName: "small" })
        }
      );
      assert(txRepeatRes.status === 200, "Repeated POST transcription returns 200 OK");
      const txRepeatData = ((await txRepeatRes.json()) as any).data;
      assert(txRepeatData.completedAt === txData1.completedAt, "Cached transcription returned without re-running");

      // 39.11 Reanalysis on Model Change
      const txReanalysisRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelName: "base" })
        }
      );
      assert(txReanalysisRes.status === 200, "Reanalysis with different model returns 200 OK");
      const txReanalysisData = ((await txReanalysisRes.json()) as any).data;
      assert(txReanalysisData.parameters.modelName === "base", "Updated model 'base' persisted");

      // 39.12 GET Transcription Endpoints & Path Masking
      const getTxRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription`
      );
      assert(getTxRes.status === 200, "GET transcription returns 200 OK");
      const getTxJson = (await getTxRes.json()) as any;
      assert(getTxJson.data.status === "completed", "GET returned status 'completed'");
      assert(Boolean(getTxJson.data.transcript), "GET includes full parsed transcript object");
      assert(getTxJson.data.transcript.segments.length > 0, "GET transcript contains segments");
      const rawTxPayload = JSON.stringify(getTxJson);
      assert(!rawTxPayload.includes("C:\\") && !rawTxPayload.includes("/Users/"), "API payload strictly masks internal server filesystem paths");

      // GET by specific transcriptionId
      const getTxByIdRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/media/${silenceMidAsset.assetId}/transcription/${txData1.id}`
      );
      assert(getTxByIdRes.status === 200, "GET transcription by ID returns 200 OK");

      // 39.13 Cancellation
      let delayResolve: ((val: any) => void) | null = null;
      setMockWorkerHandler(async (req) => {
        if (req.type === "transcribe") {
          return new Promise((resolve) => {
            delayResolve = resolve;
          });
        }
        return null;
      });

      const cancelAsset = await setupSyntheticAssetWithAudio(
        "tx_cancel_test",
        ["-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=2:channel_layout=mono"],
        "[0:a]anull[outa]"
      );
      const inFlightTxPromise = requestTranscription(projectId, cancelAsset.assetId, { modelName: "small" });

      // Wait until transcription is active
      let isTxActive = false;
      for (let i = 0; i < 50; i++) {
        if (isTranscriptionActive(cancelAsset.assetId)) {
          isTxActive = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert(isTxActive, "isTranscriptionActive returns true while transcription is active");

      // Cancel the active job
      const didCancelTx = await cancelTranscription(projectId, cancelAsset.assetId);
      assert(didCancelTx, "cancelTranscription returns true for in-flight job");
      assert(!isTranscriptionActive(cancelAsset.assetId), "isTranscriptionActive returns false immediately after cancellation");

      // Release delayed worker if still pending
      if (delayResolve) {
        (delayResolve as any)({ id: "dummy", type: "transcribe", success: true, segments: [] });
      }

      let txCancelErrorCaught = false;
      try {
        await inFlightTxPromise;
      } catch {
        txCancelErrorCaught = true;
      }
      assert(txCancelErrorCaught, "In-flight transcription promise rejects upon cancellation");

      const postCancelDoc = await transcriptionsCol.findOne({ projectId, assetId: cancelAsset.assetId });
      assert(postCancelDoc?.status === "canceled", "MongoDB record status updated to 'canceled'");

      // 39.14 Worker Failure Handling
      setMockWorkerHandler(async (req) => {
        if (req.type === "transcribe") {
          return {
            id: req.id,
            type: "transcribe",
            success: false,
            error: "Simulated worker out-of-memory error."
          };
        }
        return null;
      });

      const failAsset = await setupSyntheticAssetWithAudio(
        "tx_fail_test",
        ["-f", "lavfi", "-i", "anullsrc=sample_rate=16000:duration=2:channel_layout=mono"],
        "[0:a]anull[outa]"
      );
      let workerFailureCaught = false;
      try {
        await requestTranscription(projectId, failAsset.assetId, { modelName: "small" });
      } catch {
        workerFailureCaught = true;
      }
      assert(workerFailureCaught, "requestTranscription throws when worker reports error");
      const failedDoc = await transcriptionsCol.findOne({ projectId, assetId: failAsset.assetId });
      assert(failedDoc?.status === "failed", "MongoDB record reflects 'failed' status");
      assert(failedDoc?.error?.includes("out-of-memory"), "Error details saved in MongoDB record");

      // 39.15 Cross-Project Access Rejection
      const crossTxRes = await fetch(
        `${baseUrl}/api/projects/${project2Id}/media/${silenceMidAsset.assetId}/transcription`,
        { method: "POST" }
      );
      assert(crossTxRes.status === 404, "Cross-project transcription returns 404 Not Found");

      const crossGetTxRes = await fetch(
        `${baseUrl}/api/projects/${project2Id}/media/${silenceMidAsset.assetId}/transcription`
      );
      assert(crossGetTxRes.status === 404, "Cross-project GET transcription returns 404 Not Found");

      // Reset mock worker handler back to null
      setMockWorkerHandler(null);

      // 39.16 Worker Clean Shutdown & Process Lifecycle
      await stopWorker();
      assert(!isWorkerAlive(), "Worker process terminates cleanly without orphan processes");

      // ----------------------------------------------------
      // 40. Scene Detection & Visual Analysis Foundation (Step 5.4)
      // ----------------------------------------------------
      console.log("\n[Test 40] Scene Detection & Visual Analysis Foundation (Step 5.4)");

      // 40.1 Parameter Validation & Sensible Boundaries
      const defaultSceneParams = validateSceneDetectionParameters();
      assert(defaultSceneParams.threshold === 0.3, "Default scene threshold is 0.3");
      assert(defaultSceneParams.minSceneDuration === 0.5, "Default minimum scene duration is 0.5s");
      assert(defaultSceneParams.maxScenes === 500, "Default max scenes limit is 500");

      try {
        validateSceneDetectionParameters({ threshold: 0.01 });
        assert(false, "Reject threshold < 0.05");
      } catch (err: any) {
        assert(err.message.includes("threshold must be"), "Reject threshold < 0.05 with 400 Bad Request");
      }

      try {
        validateSceneDetectionParameters({ threshold: 1.5 });
        assert(false, "Reject threshold > 1.0");
      } catch (err: any) {
        assert(err.message.includes("threshold must be"), "Reject threshold > 1.0 with 400 Bad Request");
      }

      try {
        validateSceneDetectionParameters({ minSceneDuration: 0.05 });
        assert(false, "Reject minSceneDuration < 0.1");
      } catch (err: any) {
        assert(err.message.includes("minSceneDuration must be"), "Reject minSceneDuration < 0.1 with 400 Bad Request");
      }

      try {
        validateSceneDetectionParameters({ maxScenes: 0 });
        assert(false, "Reject maxScenes < 1");
      } catch (err: any) {
        assert(err.message.includes("maxScenes must be"), "Reject maxScenes < 1 with 400 Bad Request");
      }

      try {
        validateSceneDetectionParameters({ maxScenes: 3000 });
        assert(false, "Reject maxScenes > 2000");
      } catch (err: any) {
        assert(err.message.includes("maxScenes must be"), "Reject maxScenes > 2000 with 400 Bad Request");
      }

      const customParams = validateSceneDetectionParameters({ threshold: 0.45, minSceneDuration: 1.2, maxScenes: 250 });
      assert(customParams.threshold === 0.45 && customParams.minSceneDuration === 1.2 && customParams.maxScenes === 250, "Accept valid custom scene parameters");

      // 40.2 Parser & Continuous Coverage Interval Builder
      const sampleShowinfo = `
[Parsed_showinfo_1 @ 00000204f4a90340] config in time_base: 1/12800, frame_rate: 25/1
[Parsed_showinfo_1 @ 00000204f4a90340] n:   0 pts:  12800 pts_time:1.000000       duration:    512 duration_time:0.04    fmt:yuv420p
[Parsed_showinfo_1 @ 00000204f4a90340] n:   1 pts:  25600 pts_time:2.000000       duration:    512 duration_time:0.04    fmt:yuv420p
[Parsed_showinfo_1 @ 00000204f4a90340] n:   2 pts:  38400 pts_time:3.000000       duration:    512 duration_time:0.04    fmt:yuv420p
frame=    3 fps=0.0 q=-0.0 Lsize=N/A time=00:00:03.04 bitrate=N/A
`;
      const parsedCuts = parseShowinfoStderr(sampleShowinfo);
      assert(parsedCuts.length === 3, "parseShowinfoStderr correctly extracts 3 cut timestamps");
      assert(parsedCuts[0].timestamp === 1.0 && parsedCuts[1].timestamp === 2.0 && parsedCuts[2].timestamp === 3.0, "Parsed cut timestamps match expected values");

      const testIntervals = buildSceneIntervals(parsedCuts, 4.0, 0.5, 500, "test_analysis_1");
      assert(testIntervals.length === 4, "buildSceneIntervals constructs 4 scenes for 3 cut points across 4.0s video");
      assert(testIntervals[0].start === 0.0 && testIntervals[0].end === 1.0, "Scene 0 starts at 0.0s and ends at first cut (1.0s)");
      assert(testIntervals[3].start === 3.0 && testIntervals[3].end === 4.0, "Final scene ends exactly at video duration (4.0s)");
      assert(testIntervals.every((s, idx) => idx === 0 || s.start === testIntervals[idx - 1].end), "Scene boundaries are strictly contiguous without gaps");
      assert(testIntervals.every((s) => s.duration === Math.round((s.end - s.start) * 1000) / 1000 && s.duration > 0), "All scenes have valid positive duration");
      assert(testIntervals.every((s) => s.representativeTimestamp >= s.start && s.representativeTimestamp <= s.end), "Representative timestamps lie strictly inside scene intervals");
      assert(testIntervals.every((s) => s.id.startsWith("test_analysis_1_s")), "Scene IDs are stably scoped to analysis ID");

      // Verify cuts closer than minSceneDuration are merged deterministically
      const closeCuts = [{ timestamp: 1.0 }, { timestamp: 1.2 }, { timestamp: 2.5 }];
      const mergedIntervals = buildSceneIntervals(closeCuts, 3.0, 0.5, 500, "test_analysis_2");
      assert(mergedIntervals.length === 3, "Cut closer than minSceneDuration (1.2s - 1.0s = 0.2s < 0.5s) is merged");
      assert(mergedIntervals[0].start === 0.0 && mergedIntervals[0].end === 1.0, "Scene 0 ends at 1.0s");
      assert(mergedIntervals[1].start === 1.0 && mergedIntervals[1].end === 2.5, "Scene 1 spans across merged cut from 1.0s to 2.5s");

      // Verify maxScenes capping with score prioritization
      const scoredCuts = [
        { timestamp: 1.0, score: 0.25 },
        { timestamp: 2.0, score: 0.95 },
        { timestamp: 3.0, score: 0.40 },
        { timestamp: 4.0, score: 0.88 },
        { timestamp: 5.0, score: 0.30 }
      ];
      // Video duration = 6.0s, minSceneDuration = 0.5s, maxScenes = 3 (allowing at most 2 cuts)
      const cappedIntervals = buildSceneIntervals(scoredCuts, 6.0, 0.5, 3, "test_analysis_capped");
      assert(cappedIntervals.length === 3, "buildSceneIntervals strictly caps scene count to maxScenes = 3");
      // The 2 cuts selected should be 2.0s (score 0.95) and 4.0s (score 0.88)
      assert(cappedIntervals[0].start === 0.0 && cappedIntervals[0].end === 2.0, "Capped scene 0 ends at 2.0s (highest score cut)");
      assert(cappedIntervals[1].start === 2.0 && cappedIntervals[1].end === 4.0, "Capped scene 1 ends at 4.0s (second highest score cut)");
      assert(cappedIntervals[2].start === 4.0 && cappedIntervals[2].end === 6.0, "Capped final scene ends exactly at video duration 6.0s");

      // Verify maxScenes = 1 returns exactly 1 scene covering entire duration
      const singleSceneIntervals = buildSceneIntervals(scoredCuts, 6.0, 0.5, 1, "test_analysis_single");
      assert(singleSceneIntervals.length === 1, "maxScenes = 1 produces exactly 1 scene");
      assert(singleSceneIntervals[0].start === 0.0 && singleSceneIntervals[0].end === 6.0, "Single scene covers [0.0, 6.0]");

      // 40.3 Reject Scene Detection on Non-Video / Audio-Only File
      // Upload audioOnlyMp4Path to project 1
      const audioOnlyForm = new FormData();
      audioOnlyForm.append("file", new Blob([fs.readFileSync(audioOnlyMp4Path)], { type: "audio/mp4" }), "audio_only_probe.mp4");
      // Since Test 6 rejected audio-only upload, let's create a video asset without audio then test that
      const noVideoForm = new FormData();
      // Test invalid assetId returns 400
      const badSceneAssetRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/invalid-asset-id/scenes/detect`, {
        method: "POST"
      });
      assert(badSceneAssetRes.status === 400, "Reject scene detection with invalid assetId with 400 Bad Request");

      // Nonexistent asset returns 404
      const nonexistentAssetRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${new ObjectId().toHexString()}/scenes/detect`, {
        method: "POST"
      });
      assert(nonexistentAssetRes.status === 404, "Reject scene detection on nonexistent asset with 404 Not Found");

      // 40.4 Real Multi-Scene Synthetic Video Generation & Upload
      const multiSceneMp4Path = path.join(tempDir, "agentcut_multi_scene_test.mp4");
      if (fs.existsSync(ffmpegPath)) {
        // Generate a 4-second video with 4 distinct color scenes: Red (1s) -> Green (1s) -> Blue (1s) -> Yellow (1s)
        spawnSync(
          ffmpegPath,
          [
            "-hide_banner", "-nostdin", "-y",
            "-f", "lavfi", "-i", "color=c=red:d=1:r=25:size=320x240",
            "-f", "lavfi", "-i", "color=c=green:d=1:r=25:size=320x240",
            "-f", "lavfi", "-i", "color=c=blue:d=1:r=25:size=320x240",
            "-f", "lavfi", "-i", "color=c=yellow:d=1:r=25:size=320x240",
            "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]",
            "-map", "[v]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            multiSceneMp4Path
          ],
          { stdio: "ignore" }
        );
      }
      assert(fs.existsSync(multiSceneMp4Path) && fs.statSync(multiSceneMp4Path).size > 0, "Real synthetic multi-scene MP4 generated");

      // Upload multi-scene video to project 1
      const multiSceneBuffer = fs.readFileSync(multiSceneMp4Path);
      const multiSceneFormData = new FormData();
      multiSceneFormData.append("file", new Blob([multiSceneBuffer], { type: "video/mp4" }), "multi_scene.mp4");
      const multiSceneUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: multiSceneFormData
      });
      assert(multiSceneUploadRes.status === 201, "Multi-scene video uploaded successfully with 201 Created");
      const multiSceneAsset = ((await multiSceneUploadRes.json()) as { data: { id: string } }).data;
      const multiSceneAssetId = multiSceneAsset.id;

      // 40.5 Real Scene Detection & Representative Frame Extraction
      const detectScenesRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${multiSceneAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.3, minSceneDuration: 0.5 })
      });
      assert(detectScenesRes.status === 200, "POST /api/projects/:id/media/:assetId/scenes/detect returns 200 OK");
      const sceneData = ((await detectScenesRes.json()) as { data: any }).data;
      assert(sceneData.status === "completed", "Scene detection artifact status is 'completed'");
      assert(sceneData.videoDuration === 4.0, "Video duration reported accurately as 4.0s");
      assert(sceneData.scenes.length >= 3, `Detected visual scene changes across 4 color blocks (count: ${sceneData.scenes.length})`);
      assert(sceneData.scenes[0].start === 0.0, "First scene starts strictly at 0.0s");
      assert(sceneData.scenes[sceneData.scenes.length - 1].end === 4.0, "Last scene ends strictly at video duration (4.0s)");
      assert(sceneData.scenes.every((s: any, idx: number) => idx === 0 || s.start === sceneData.scenes[idx - 1].end), "Continuous scene coverage across entire duration");
      assert(sceneData.scenes.every((s: any) => s.frameAvailable === true), "Representative frames extracted for all detected scenes");
      assert(sceneData.scenes.every((s: any) => s.frameUrl.includes(`/scenes/analyses/${sceneData.id}/frames/${s.id}`)), "Frame URLs correctly embed analysis ID and scene ID");
      assert(!JSON.stringify(sceneData).includes(os.homedir()), "Client response strictly hides internal server filesystem paths");

      // 40.6 Physical Frame File Verification & HTTP Streaming
      const analysisDir = getSceneAnalysisDir(projectId, multiSceneAssetId, sceneData.id);
      assert(fs.existsSync(analysisDir), "Analysis-specific frame directory exists on disk");
      const firstScene = sceneData.scenes[0];
      const firstFramePath = resolveSceneFramePath(projectId, multiSceneAssetId, sceneData.id, firstScene.id);
      assert(fs.existsSync(firstFramePath) && fs.statSync(firstFramePath).size > 0, "Representative frame JPEG exists on disk with non-zero size");

      // Stream frame via primary URL
      const streamFrameRes = await fetch(`${baseUrl}${firstScene.frameUrl}`);
      assert(streamFrameRes.status === 200, "GET frame endpoint returns 200 OK");
      assert(streamFrameRes.headers.get("content-type") === "image/jpeg", "Frame Content-Type is image/jpeg");
      assert(streamFrameRes.headers.get("cache-control") === "private, max-age=86400, immutable", "Cache-Control is private, max-age=86400, immutable");
      const frameEtag = streamFrameRes.headers.get("etag");
      assert(Boolean(frameEtag) && frameEtag!.startsWith('"') && frameEtag!.endsWith('"') && !frameEtag!.startsWith('W/'), "Valid strong ETag returned for frame");

      // Conditional GET with If-None-Match returns 304 Not Modified
      const notModifiedRes = await fetch(`${baseUrl}${firstScene.frameUrl}`, {
        headers: { "If-None-Match": frameEtag! }
      });
      assert(notModifiedRes.status === 304, "Conditional GET with If-None-Match returns 304 Not Modified");

      // Stream frame via convenience alias route
      const aliasFrameRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${multiSceneAssetId}/scenes/frames/${firstScene.id}`);
      assert(aliasFrameRes.status === 200, "Convenience alias frame endpoint returns 200 OK");
      assert(aliasFrameRes.headers.get("etag") === frameEtag, "Convenience alias returns matching strong ETag");

      // 40.7 Security & Path Traversal Rejection
      const traversalRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${multiSceneAssetId}/scenes/analyses/${sceneData.id}/frames/..%2f..%2fsecret`);
      assert(traversalRes.status === 400, "Path traversal attempt in scene frame route rejected with 400 Bad Request");

      const crossProjectFrameRes = await fetch(`${baseUrl}/api/projects/${project2Id}/media/${multiSceneAssetId}/scenes/analyses/${sceneData.id}/frames/${firstScene.id}`);
      assert(crossProjectFrameRes.status === 404, "Cross-project frame access rejected with 404 Not Found");

      // 40.8 Cache Reuse for Identical Parameters
      const cachedDetectRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${multiSceneAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.3, minSceneDuration: 0.5 })
      });
      assert(cachedDetectRes.status === 200, "Repeated POST /scenes/detect returns 200 OK");
      const cachedData = ((await cachedDetectRes.json()) as { data: any }).data;
      assert(cachedData.id === sceneData.id, "Cached analysis returned without re-running FFmpeg");

      // 40.9 Parameter Change & Isolation
      // Higher threshold 0.9 creates a replacement analysis in its own directory
      const higherThresholdRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${multiSceneAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.9, minSceneDuration: 0.5 })
      });
      assert(higherThresholdRes.status === 200, "Reanalysis with different threshold returns 200 OK");
      const higherData = ((await higherThresholdRes.json()) as { data: any }).data;
      assert(higherData.id !== sceneData.id, "New analysis assigned distinct analysisId");
      assert(higherData.parameters.threshold === 0.9, "Updated threshold (0.9) persisted in artifact");
      // Check old analysis directory remains intact on disk
      assert(fs.existsSync(firstFramePath), "Previous completed analysis frames preserved intact on disk after reanalysis");

      // 40.10 Concurrency Deduplication
      const concurrMp4Path = path.join(tempDir, "agentcut_concurr_scene_test.mp4");
      spawnSync(
        ffmpegPath,
        [
          "-hide_banner", "-nostdin", "-y",
          "-f", "lavfi", "-i", "color=c=red:d=1:r=25:size=320x240",
          "-f", "lavfi", "-i", "color=c=blue:d=1:r=25:size=320x240",
          "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
          "-map", "[v]",
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          concurrMp4Path
        ],
        { stdio: "ignore" }
      );
      const concurrBuffer = fs.readFileSync(concurrMp4Path);
      const concurrFormData = new FormData();
      concurrFormData.append("file", new Blob([concurrBuffer], { type: "video/mp4" }), "concurr_scene.mp4");
      const concurrUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: concurrFormData
      });
      assert(concurrUploadRes.status === 201, "Uploaded video for concurrency deduplication test");
      const concurrAssetId = ((await concurrUploadRes.json()) as { data: { id: string } }).data.id;

      // Fire 2 concurrent POST requests with identical parameters
      const [concurrRes1, concurrRes2] = await Promise.all([
        fetch(`${baseUrl}/api/projects/${projectId}/media/${concurrAssetId}/scenes/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threshold: 0.3 })
        }),
        fetch(`${baseUrl}/api/projects/${projectId}/media/${concurrAssetId}/scenes/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threshold: 0.3 })
        })
      ]);
      assert(concurrRes1.status === 200 && concurrRes2.status === 200, "Concurrent scene detection requests both return 200 OK");
      const concurrData1 = ((await concurrRes1.json()) as { data: any }).data;
      const concurrData2 = ((await concurrRes2.json()) as { data: any }).data;
      assert(concurrData1.id === concurrData2.id, "Concurrent detection requests return identical analysis artifact");

      // 40.11 In-Flight Cancellation & Replace-and-Cancel Concurrency Races
      const cancelMp4Path = path.join(tempDir, "agentcut_cancel_scene_test.mp4");
      spawnSync(
        ffmpegPath,
        [
          "-hide_banner", "-nostdin", "-y",
          "-f", "lavfi", "-i", "color=c=black:d=5:r=25:size=320x240",
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          cancelMp4Path
        ],
        { stdio: "ignore" }
      );
      const cancelBuffer = fs.readFileSync(cancelMp4Path);
      const cancelFormData = new FormData();
      cancelFormData.append("file", new Blob([cancelBuffer], { type: "video/mp4" }), "cancel_scene.mp4");
      const cancelUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: cancelFormData
      });
      const cancelAssetId = ((await cancelUploadRes.json()) as { data: { id: string } }).data.id;

      // Start detection without awaiting, then cancel
      const startDetectionPromise = fetch(`${baseUrl}/api/projects/${projectId}/media/${cancelAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.3 })
      });

      // Brief yield so the active job is registered
      await new Promise((r) => setTimeout(r, 50));

      const sceneCancelRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${cancelAssetId}/scenes/cancel`, {
        method: "POST"
      });
      assert(sceneCancelRes.status === 200, "POST /api/projects/:id/media/:assetId/scenes/cancel returns 200 OK");
      const sceneCancelJson = (await sceneCancelRes.json()) as { message?: string };
      assert(sceneCancelJson.message === "Scene detection canceled successfully.", "Cancel response confirms cancellation");

      // The in-flight detection request should fail or return error
      const startResult = await startDetectionPromise;
      assert(startResult.status === 500 || startResult.status === 200, "Canceled request handled cleanly without server crash");

      // Check database status is 'canceled'
      const canceledDoc = await getDB().collection("scene_detections").findOne({ projectId, assetId: cancelAssetId });
      assert(canceledDoc?.status === "canceled", "MongoDB record updated to 'canceled' status upon cancellation");

      // 40.12 Replace-and-Cancel Race Test: In-flight replacement with different parameters
      // Start detection with threshold 0.2
      const initialReplacePromise = fetch(`${baseUrl}/api/projects/${projectId}/media/${cancelAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.2 })
      });
      await new Promise((r) => setTimeout(r, 30));

      // Trigger replacement request with threshold 0.7 while initial is active
      const replacementRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${cancelAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.7 })
      });
      assert(replacementRes.status === 200, "Replacement request with different parameters returns 200 OK");
      const replacementData = ((await replacementRes.json()) as { data: any }).data;
      assert(replacementData.status === "completed", "Replacement analysis completed successfully");
      assert(replacementData.parameters.threshold === 0.7, "Replacement analysis reflects new threshold 0.7");

      // Initial replaced request should be canceled cleanly
      const initialReplacedResult = await initialReplacePromise;
      assert(initialReplacedResult.status === 500 || initialReplacedResult.status === 200, "Replaced job terminated cleanly");

      // 40.13 Cancellation during Multi-Frame Extraction
      // Create multi-cut video with 6 distinct cuts to trigger multiple parallel frame extractions
      const multiCutMp4Path = path.join(tempDir, "agentcut_multi_cut_cancel.mp4");
      spawnSync(
        ffmpegPath,
        [
          "-hide_banner", "-nostdin", "-y",
          "-f", "lavfi", "-i", "color=c=red:d=1:r=25:size=320x240",
          "-f", "lavfi", "-i", "color=c=green:d=1:r=25:size=320x240",
          "-f", "lavfi", "-i", "color=c=blue:d=1:r=25:size=320x240",
          "-f", "lavfi", "-i", "color=c=yellow:d=1:r=25:size=320x240",
          "-f", "lavfi", "-i", "color=c=magenta:d=1:r=25:size=320x240",
          "-f", "lavfi", "-i", "color=c=cyan:d=1:r=25:size=320x240",
          "-filter_complex", "[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0[v]",
          "-map", "[v]",
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          multiCutMp4Path
        ],
        { stdio: "ignore" }
      );
      const multiCutBuffer = fs.readFileSync(multiCutMp4Path);
      const multiCutForm = new FormData();
      multiCutForm.append("file", new Blob([multiCutBuffer], { type: "video/mp4" }), "multi_cut_cancel.mp4");
      const multiCutUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: multiCutForm
      });
      const multiCutAssetId = ((await multiCutUploadRes.json()) as { data: { id: string } }).data.id;

      // Start detection and yield until frame extraction is active
      const frameExtractionJobPromise = fetch(`${baseUrl}/api/projects/${projectId}/media/${multiCutAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.3 })
      });
      await new Promise((r) => setTimeout(r, 60));

      // Cancel while extraction is active
      const frameCancelRes = await fetch(`${baseUrl}/api/projects/${projectId}/media/${multiCutAssetId}/scenes/cancel`, {
        method: "POST"
      });
      assert(frameCancelRes.status === 200, "Cancel during active frame extraction returns 200 OK");
      await frameExtractionJobPromise.catch(() => {});

      // Confirm all temporary files in analysis dir are cleaned up
      const multiCutScenesDir = getAssetScenesDir(projectId, multiCutAssetId);
      const remainingAnalysisDirs = fs.existsSync(multiCutScenesDir) ? fs.readdirSync(multiCutScenesDir) : [];
      assert(remainingAnalysisDirs.length === 0, "No orphaned analysis directories or frames remain after cancellation during frame extraction");
      assert(!isSceneDetectionActive(projectId, multiCutAssetId), "Job is fully unregistered and inactive after cancellation");

      // Verify directory was removed strictly after all processes exited (no post-cleanup file recreation)
      await new Promise((r) => setTimeout(r, 200));
      const postWaitDirs = fs.existsSync(multiCutScenesDir) ? fs.readdirSync(multiCutScenesDir) : [];
      assert(postWaitDirs.length === 0, "Active processes did not write any frames after directory was deleted");

      // 40.14 Process-Lifecycle & Termination Safety Verifications
      console.log("  - Verifying process exit tracking and termination safety properties");

      // Helper to generate a mock ChildProcess
      function createMockChildProcess(pid: number) {
        const proc = new EventEmitter() as any;
        proc.pid = pid;
        proc.killed = false;
        proc.exitCode = null;
        proc.signalCode = null;
        proc.lastSignal = null;
        proc.kill = (signal?: string) => {
          proc.killed = true;
          proc.lastSignal = signal || "SIGTERM";
          return true;
        };
        return proc;
      }

      // 1. isProcessExited guarantees: proc.killed === true is NOT proof of process exit
      const mockProc1 = createMockChildProcess(1001);
      mockProc1.killed = true; // Signal was sent, but process has not yet exited!
      assert(isProcessExited(mockProc1) === false, "isProcessExited returns false when killed is true but exitCode and signalCode are null");

      mockProc1.exitCode = 0;
      assert(isProcessExited(mockProc1) === true, "isProcessExited returns true when exitCode is non-null");

      const mockProc2 = createMockChildProcess(1002);
      mockProc2.signalCode = "SIGTERM";
      assert(isProcessExited(mockProc2) === true, "isProcessExited returns true when signalCode is non-null");

      // 2. terminateProcessWithGracePeriod: proc.killed === true does not trigger premature exit resolution
      const mockProc3 = createMockChildProcess(1003);
      let termResolved = false;
      const termPromise = terminateProcessWithGracePeriod(mockProc3, 50, 200).then((res) => {
        termResolved = true;
        return res;
      });

      // Immediately after call, SIGTERM was sent and proc.killed === true, but promise must NOT have resolved yet
      assert(mockProc3.killed === true, "SIGTERM signal was sent to process");
      assert(mockProc3.lastSignal === "SIGTERM", "Initial signal sent is SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      assert(!termResolved, "terminateProcessWithGracePeriod does NOT resolve early merely because proc.killed is true");

      // Emit close event, which should resolve the termination promise
      mockProc3.exitCode = 0;
      mockProc3.emit("close", 0, null);
      const termResult = await termPromise;
      assert(termResult.exited === true, "terminateProcessWithGracePeriod settles with exited: true upon confirmed close event");

      // 3. Escalation to SIGKILL after grace period and continued awaiting
      const mockProc4 = createMockChildProcess(1004);
      let killEscalated = false;
      const termPromise4 = terminateProcessWithGracePeriod(mockProc4, 40, 250).then((res) => {
        killEscalated = true;
        return res;
      });

      await new Promise((r) => setTimeout(r, 60)); // Yield beyond 40ms grace period
      assert(mockProc4.lastSignal === "SIGKILL", "Escalates to SIGKILL after gracePeriodMs expires without process exit");
      assert(!killEscalated, "Does NOT immediately resolve upon sending SIGKILL; continues awaiting close/exit event");

      mockProc4.signalCode = "SIGKILL";
      mockProc4.emit("exit", null, "SIGKILL");
      const termResult4 = await termPromise4;
      assert(termResult4.exited === true, "Awaits actual exit event after SIGKILL escalation");

      // 4. Hard deadline timeout on unresponsive process preserves directory and returns exited: false
      const mockProc5 = createMockChildProcess(1005);
      const termResult5 = await terminateProcessWithGracePeriod(mockProc5, 30, 80);
      assert(termResult5.exited === false, "Returns exited: false when process does not exit within bounded deadline");
      assert(termResult5.pid === 1005, "Unexited result reports correct process PID");

      // 5. terminateJobProcesses reports unexited PIDs, allExited: false, and preserves analysis directory
      const mockPreserveDir = getSceneAnalysisDir(projectId, "mock_asset_1", "mock_analysis_1");
      fs.mkdirSync(mockPreserveDir, { recursive: true });
      fs.writeFileSync(path.join(mockPreserveDir, "frame_preserve_test.jpg"), "dummy frame data");

      const mockJob: any = {
        jobId: "mock_job_1",
        analysisId: "mock_analysis_1",
        projectId,
        assetId: "mock_asset_1",
        parameters: { threshold: 0.3, minSceneDuration: 0.5, maxScenes: 500 },
        canceled: false,
        detectionProcess: mockProc5, // Never exited
        activeFrameProcesses: new Set()
      };
      const jobTermRes = await terminateJobProcesses(mockJob, 30, 80);
      assert(jobTermRes.allExited === false, "terminateJobProcesses reports allExited: false when a process remains alive");
      assert(jobTermRes.unexitedPids.includes(1005), "terminateJobProcesses lists unexited PID 1005");

      // Verify directory preservation guard: cleanup must be skipped if allExited === false
      if (jobTermRes.allExited) {
        fs.rmSync(mockPreserveDir, { recursive: true, force: true });
      }
      assert(fs.existsSync(mockPreserveDir), "Analysis directory is PRESERVED on disk when child process fails to exit");
      try { fs.rmSync(mockPreserveDir, { recursive: true, force: true }); } catch {}

      // 6. An 'error' event alone cannot establish that a running process has exited
      const mockProcError = createMockChildProcess(1006);
      let errorSettled = false;
      const errorTermPromise = terminateProcessWithGracePeriod(mockProcError, 50, 150).then((res) => {
        errorSettled = true;
        return res;
      });
      mockProcError.emit("error", new Error("Simulated stream error"));
      await new Promise((r) => setTimeout(r, 20));
      assert(!errorSettled, "An 'error' event alone does NOT mark a running process as exited");
      mockProcError.exitCode = 0;
      mockProcError.emit("close", 0, null);
      const errorTermResult = await errorTermPromise;
      assert(errorTermResult.exited === true, "Process only settled as exited when confirmed close event arrives");

      // 7. Concurrent cancellation deduplication integration test
      // Start a real scene detection and fire 3 concurrent cancellation requests simultaneously
      const concurrCancelMp4 = path.join(tempDir, "agentcut_concurrent_cancel.mp4");
      spawnSync(
        ffmpegPath,
        [
          "-hide_banner", "-nostdin", "-y",
          "-f", "lavfi", "-i", "color=c=black:d=4:r=25:size=320x240",
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          concurrCancelMp4
        ],
        { stdio: "ignore" }
      );
      const concurrCancelForm = new FormData();
      concurrCancelForm.append("file", new Blob([fs.readFileSync(concurrCancelMp4)], { type: "video/mp4" }), "concurr_cancel.mp4");
      const concurrCancelUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/media`, {
        method: "POST",
        body: concurrCancelForm
      });
      const concurrCancelAssetId = ((await concurrCancelUploadRes.json()) as { data: { id: string } }).data.id;

      // Start detection
      const activeJobPromise = fetch(`${baseUrl}/api/projects/${projectId}/media/${concurrCancelAssetId}/scenes/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.3 })
      });
      await new Promise((r) => setTimeout(r, 40));

      // Trigger 3 concurrent cancellations simultaneously
      const [cRes1, cRes2, cRes3] = await Promise.all([
        fetch(`${baseUrl}/api/projects/${projectId}/media/${concurrCancelAssetId}/scenes/cancel`, { method: "POST" }),
        fetch(`${baseUrl}/api/projects/${projectId}/media/${concurrCancelAssetId}/scenes/cancel`, { method: "POST" }),
        fetch(`${baseUrl}/api/projects/${projectId}/media/${concurrCancelAssetId}/scenes/cancel`, { method: "POST" })
      ]);
      assert(cRes1.status === 200 && cRes2.status === 200 && cRes3.status === 200, "All concurrent cancellation calls return 200 OK");
      await activeJobPromise.catch(() => {});

      // Verify no orphaned directory exists
      const concurrCancelScenesDir = getAssetScenesDir(projectId, concurrCancelAssetId);
      const concurrRemainingDirs = fs.existsSync(concurrCancelScenesDir) ? fs.readdirSync(concurrCancelScenesDir) : [];
      assert(concurrRemainingDirs.length === 0, "Analysis directory safely removed after concurrent cancellation");

      try {
        if (fs.existsSync(concurrCancelMp4)) fs.unlinkSync(concurrCancelMp4);
      } catch {}

      // Clean up temporary synthetic videos
      try {
        if (fs.existsSync(multiSceneMp4Path)) fs.unlinkSync(multiSceneMp4Path);
        if (fs.existsSync(concurrMp4Path)) fs.unlinkSync(concurrMp4Path);
        if (fs.existsSync(cancelMp4Path)) fs.unlinkSync(cancelMp4Path);
        if (fs.existsSync(multiCutMp4Path)) fs.unlinkSync(multiCutMp4Path);
      } catch {}

      // ----------------------------------------------------
      // 24. Project Deletion: Removes Timeline Metadata & Preserves Files
      // ----------------------------------------------------
      console.log("\n[Test 24] Project Deletion: Removes Timeline Metadata & Preserves Local Files");
      const assetDoc = await mediaAssetsCol.findOne({ projectId });
      assert(Boolean(assetDoc), "Asset document exists in MongoDB before deletion");
      const storedFileName = assetDoc?.storedFileName;
      const filePathOnDisk = resolveStoredFilePath(projectId, storedFileName);
      assert(fs.existsSync(filePathOnDisk), "Media file exists on filesystem before project deletion");

      // Confirm timeline document exists in DB before project deletion
      const tlDocBefore = await timelinesCol.findOne({ projectId });
      assert(Boolean(tlDocBefore), "Timeline metadata exists in MongoDB before deletion");

      // Confirm render job metadata exists in DB before project deletion
      const renderJobsBefore = await renderJobsCol.find({ projectId }).toArray();
      assert(renderJobsBefore.length > 0, "Render job metadata exists in MongoDB before project deletion");

      // Confirm audio extraction metadata exists in DB before project deletion
      const extractionsBefore = await audioExtractionsCol.find({ projectId }).toArray();
      assert(extractionsBefore.length > 0, "Audio extraction metadata exists in MongoDB before project deletion");

      // Confirm silence detection metadata exists in DB before project deletion
      const silenceBefore = await silenceDetectionsCol.find({ projectId }).toArray();
      assert(silenceBefore.length > 0, "Silence detection metadata exists in MongoDB before project deletion");

      // Confirm transcription metadata exists in DB before project deletion
      const transcriptionsBefore = await transcriptionsCol.find({ projectId }).toArray();
      assert(transcriptionsBefore.length > 0, "Transcription metadata exists in MongoDB before project deletion");

      // Confirm scene detection metadata exists in DB before project deletion
      const sceneDetectionsCol = getDB().collection("scene_detections");
      const sceneBefore = await sceneDetectionsCol.find({ projectId }).toArray();
      assert(sceneBefore.length > 0, "Scene detection metadata exists in MongoDB before project deletion");

      // Create a render job for project 2 to verify cross-project isolation during deletion
      const otherProjectJobId = new ObjectId().toHexString();
      await renderJobsCol.insertOne({
        _id: new ObjectId(),
        jobId: otherProjectJobId,
        projectId: project2Id,
        timelineId: "tl_proj2",
        status: "queued",
        progress: 0,
        plan: {
          projectId: project2Id,
          timelineId: "tl_proj2",
          settings: { width: 1920, height: 1080, frameRate: 30 },
          duration: 10,
          videoClips: [],
          audioClips: [],
          tracks: [],
          output: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", pixelFormat: "yuv420p" },
          createdAt: new Date().toISOString()
        },
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Delete the project
      const deleteProjRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
        method: "DELETE"
      });
      assert(deleteProjRes.status === 200, "DELETE /api/projects/:id returns 200");

      // Check project metadata deleted
      const checkProjRes = await fetch(`${baseUrl}/api/projects/${projectId}`);
      assert(checkProjRes.status === 404, "Project record removed from MongoDB");

      // Check media metadata deleted
      const remainingAssetDocs = await mediaAssetsCol.find({ projectId }).toArray();
      assert(remainingAssetDocs.length === 0, "Associated media asset metadata records removed from MongoDB");

      // Check timeline metadata deleted
      const remainingTlDocs = await timelinesCol.find({ projectId }).toArray();
      assert(remainingTlDocs.length === 0, "Associated timeline metadata record removed from MongoDB");

      // Check render job metadata deleted for deleted project
      const remainingRenderJobDocs = await renderJobsCol.find({ projectId }).toArray();
      assert(remainingRenderJobDocs.length === 0, "Associated render job metadata records removed from MongoDB upon project deletion");

      // Check audio extraction metadata deleted for deleted project
      const remainingExtractionDocs = await audioExtractionsCol.find({ projectId }).toArray();
      assert(remainingExtractionDocs.length === 0, "Associated audio extraction metadata records removed from MongoDB upon project deletion");

      // Check silence detection metadata deleted for deleted project
      const remainingSilenceDocs = await silenceDetectionsCol.find({ projectId }).toArray();
      assert(remainingSilenceDocs.length === 0, "Associated silence detection metadata records removed from MongoDB upon project deletion");

      // Check transcription metadata deleted for deleted project
      const remainingTxDocs = await transcriptionsCol.find({ projectId }).toArray();
      assert(remainingTxDocs.length === 0, "Associated transcription metadata records removed from MongoDB upon project deletion");

      // Check scene detection metadata deleted for deleted project
      const remainingSceneDocs = await sceneDetectionsCol.find({ projectId }).toArray();
      assert(remainingSceneDocs.length === 0, "Associated scene detection metadata records removed from MongoDB upon project deletion");

      // Check render job metadata belonging to project 2 remains intact
      const otherJobStillExists = await renderJobsCol.findOne({ jobId: otherProjectJobId });
      assert(Boolean(otherJobStillExists), "Render jobs belonging to another project remain completely intact in MongoDB");

      // POLICY VERIFICATION: The physical media file on disk must STILL exist!
      assert(
        fs.existsSync(filePathOnDisk),
        "CRITICAL POLICY: Physical media file on disk is PRESERVED after project deletion"
      );

      // Clean up project 2 (which should also cascade-delete its render job)
      await fetch(`${baseUrl}/api/projects/${project2Id}`, { method: "DELETE" });
      const postCleanProj2Jobs = await renderJobsCol.find({ projectId: project2Id }).toArray();
      assert(postCleanProj2Jobs.length === 0, "Deleting project 2 removes its associated render jobs as well");


      // Clean up temporary disk files
      try {
        if (fs.existsSync(filePathOnDisk)) fs.unlinkSync(filePathOnDisk);
        if (fs.existsSync(validMp4Path)) fs.unlinkSync(validMp4Path);
        if (fs.existsSync(audioOnlyMp4Path)) fs.unlinkSync(audioOnlyMp4Path);
        if (fs.existsSync(videoWithAudioPath)) fs.unlinkSync(videoWithAudioPath);
        if (fs.existsSync(videoWithoutAudioPath)) fs.unlinkSync(videoWithoutAudioPath);
      } catch {}
    } else {
      console.log("  - Skipped: validMp4 test file not generated");
    }

    console.log(`\n=== Verification Results: ${passed} passed, ${failed} failed ===`);
  } catch (err) {
    console.error("Test caught fatal error:", err);
    failed++;
  } finally {
    server!.close();
    await closeDB();
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests().catch((err) => {
  console.error("Test execution threw error:", err);
  process.exit(1);
});
