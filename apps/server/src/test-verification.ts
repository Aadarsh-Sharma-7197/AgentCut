process.env.NODE_ENV = "test";

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
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
