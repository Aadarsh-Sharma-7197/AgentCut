process.env.NODE_ENV = "test";

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import os from "os";
import { spawnSync } from "child_process";

dotenv.config({ path: "./apps/server/.env" });
dotenv.config({ path: path.resolve(process.cwd(), "apps/server/.env") });

import app from "./index.js";
import { connectDB, closeDB, getDB } from "./config/db.js";
import { getProjectMediaDir, resolveStoredFilePath } from "./config/storage.js";
import { getFFprobePath } from "./utils/ffprobe.js";
import type { Server } from "http";

async function runTests() {
  console.log("=== AgentCut Phase 1 Step 2 Verification Test Suite ===");
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
    console.log("\n[Test 2] Create Test Project");
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Media Test Project ${Date.now()}` })
    });
    assert(createProjectRes.status === 201, "Project created successfully");
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
    assert(txtRes.status === 400 || txtRes.status === 500, "Unsupported extension rejected (.txt)");

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
    } else {
      console.log("  - Skipped: ffmpeg audio file generator not available");
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
    } else {
      console.log("  - Skipped: valid test mp4 generator was not run");
    }

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

    // Standard stream request (no Range)
    const fullStreamRes = await fetch(streamUrl);
    assert(fullStreamRes.status === 200, "Stream without Range returns 200 OK");
    assert(fullStreamRes.headers.get("accept-ranges") === "bytes", "Accept-Ranges: bytes is advertised");
    assert(Boolean(fullStreamRes.headers.get("content-length")), "Content-Length header is present");

    // Range request (Partial Content)
    const rangeRes = await fetch(streamUrl, {
      headers: { Range: "bytes=0-100" }
    });
    assert(rangeRes.status === 206, "Range request returns 206 Partial Content");
    assert(rangeRes.headers.get("content-length") === "101", "Chunk size is exactly 101 bytes");
    assert(
      Boolean(rangeRes.headers.get("content-range")?.startsWith("bytes 0-100/")),
      "Content-Range header matches requested slice"
    );

    // ----------------------------------------------------
    // 13. Project Deletion: Removes Metadata, Preserves Files
    // ----------------------------------------------------
    console.log("\n[Test 13] Project Deletion Non-Destructive File Policy");
    // Verify file exists on disk
    const mediaAssetsCol = getDB().collection("media_assets");
    const assetDoc = await mediaAssetsCol.findOne({ projectId });
    assert(Boolean(assetDoc), "Asset document exists in MongoDB before deletion");
    const storedFileName = assetDoc?.storedFileName;
    const filePathOnDisk = resolveStoredFilePath(projectId, storedFileName);
    assert(fs.existsSync(filePathOnDisk), "Media file exists on filesystem before project deletion");

    // Delete the project
    const deleteProjRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: "DELETE"
    });
    assert(deleteProjRes.status === 200, "Project deleted successfully");

    // Check that project metadata is deleted
    const checkProjRes = await fetch(`${baseUrl}/api/projects/${projectId}`);
    assert(checkProjRes.status === 404, "Project record removed from MongoDB");

    // Check that media_assets metadata records are deleted
    const remainingAssetDocs = await mediaAssetsCol.find({ projectId }).toArray();
    assert(remainingAssetDocs.length === 0, "Associated media asset metadata records removed from MongoDB");

    // POLICY VERIFICATION: The physical media file on disk must STILL exist!
    assert(
      fs.existsSync(filePathOnDisk),
      "CRITICAL: Physical media file on disk is PRESERVED after project deletion"
    );

    // Clean up project 2
    await fetch(`${baseUrl}/api/projects/${project2Id}`, { method: "DELETE" });

    // Clean up temporary disk files
    try {
      if (fs.existsSync(filePathOnDisk)) fs.unlinkSync(filePathOnDisk);
      if (fs.existsSync(validMp4Path)) fs.unlinkSync(validMp4Path);
      if (fs.existsSync(audioOnlyMp4Path)) fs.unlinkSync(audioOnlyMp4Path);
    } catch {}

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
