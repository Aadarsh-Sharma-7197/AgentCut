process.env.NODE_ENV = "test";

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import { spawnSync } from "child_process";

dotenv.config({ path: "./apps/server/.env" });
dotenv.config({ path: path.resolve(process.cwd(), "apps/server/.env") });

const { default: app } = await import("./index.js");
import { connectDB, closeDB, getDB } from "./config/db.js";
import { getProjectMediaDir, resolveStoredFilePath, getProjectExportDir, resolveExportFilePath } from "./config/storage.js";
import { getFFprobePath } from "./utils/ffprobe.js";
import { getFFmpegPath, checkFFmpegAvailable, validateFFmpegSafety } from "./utils/ffmpeg.js";
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
      assert(jobInDb?.status === "queued", "Persisted DB status is 'queued'");

      // Verify retrieving single job via GET endpoint
      const getJobRes = await fetch(`${baseUrl}/api/projects/${projectId}/render/jobs/${createdJob.id}`);
      assert(getJobRes.status === 200, "GET /api/projects/:id/render/jobs/:jobId returns 200 OK");
      const getJobJson = (await getJobRes.json()) as any;
      assert(getJobJson.data?.id === createdJob.id, "Retrieved job ID matches created job");
      assert(getJobJson.data?.status === "queued", "Retrieved job status is 'queued'");

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
      // 24. Project Deletion: Removes Timeline Metadata & Preserves Files
      // ----------------------------------------------------
      console.log("\n[Test 24] Project Deletion: Removes Timeline Metadata & Preserves Local Files");
      const mediaAssetsCol = getDB().collection("media_assets");
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
      } catch {}
    } else {
      console.log("  - Skipped: validMp4 test file not generated");
    }

    console.log(`\n=== Verification Results: ${passed} passed, ${failed} failed ===`);
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
