process.env.NODE_ENV = "test";

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: "./apps/server/.env" });
dotenv.config({ path: path.resolve(process.cwd(), "apps/server/.env") });

import app from "./index.js";
import { connectDB, closeDB } from "./config/db.js";
import type { Server } from "http";

async function runTests() {
  console.log("=== AgentCut Phase 1 Step 1 Verification Test Suite ===");
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

  try {
    // 1. Health check endpoint
    console.log("\n[Test 1] Health Check Endpoint");
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert(healthRes.status === 200, "GET /health returns 200");
    assert(healthJson.status === "ok", "Health status is 'ok'");
    assert(healthJson.service === "server", "Health service is 'server'");

    // 2. Reject empty project name
    console.log("\n[Test 2] Project Name Validation");
    const emptyRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" })
    });
    assert(emptyRes.status === 400, "Empty name returns 400 Bad Request");

    // 3. Reject whitespace-only name
    const wsRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " })
    });
    assert(wsRes.status === 400, "Whitespace-only name returns 400 Bad Request");

    // 4. Create valid project
    console.log("\n[Test 3] Create Valid Project");
    const testProjectName = `Test Project ${Date.now()}`;
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testProjectName })
    });
    assert(createRes.status === 201, "POST /api/projects returns 201 Created");
    const createJson = (await createRes.json()) as { data?: { id?: string; name?: string } };
    const createdProject = createJson.data;
    assert(Boolean(createdProject?.id), "Created project has valid string ID");
    assert(createdProject?.name === testProjectName, "Created project has correct name");

    // 5. Get all projects
    console.log("\n[Test 4] Get All Projects");
    const listRes = await fetch(`${baseUrl}/api/projects`);
    assert(listRes.status === 200, "GET /api/projects returns 200");
    const listJson = (await listRes.json()) as { data?: Array<{ id: string }> };
    assert(Array.isArray(listJson.data), "Response data is an array");
    const foundInList = Boolean(listJson.data?.some((p: { id: string }) => p.id === createdProject?.id));
    assert(foundInList, "Newly created project appears in project list");

    // 6. Get single project by ID
    console.log("\n[Test 5] Get Single Project by ID");
    const getRes = await fetch(`${baseUrl}/api/projects/${createdProject?.id}`);
    assert(getRes.status === 200, "GET /api/projects/:id returns 200");
    const getJson = (await getRes.json()) as { data?: { id?: string; name?: string } };
    assert(getJson.data?.id === createdProject?.id, "Retrieved project ID matches");
    assert(getJson.data?.name === testProjectName, "Retrieved project name matches");

    // 7. Invalid project ID handling
    console.log("\n[Test 6] Invalid & Nonexistent IDs");
    const invalidIdRes = await fetch(`${baseUrl}/api/projects/not-a-valid-hex-id`);
    assert(invalidIdRes.status === 400, "Invalid ObjectId format returns 400");

    const nonExistentIdRes = await fetch(`${baseUrl}/api/projects/000000000000000000000000`);
    assert(nonExistentIdRes.status === 404, "Nonexistent valid ID returns 404");

    // 8. Delete project
    console.log("\n[Test 7] Delete Project");
    const deleteRes = await fetch(`${baseUrl}/api/projects/${createdProject?.id}`, {
      method: "DELETE"
    });
    assert(deleteRes.status === 200, "DELETE /api/projects/:id returns 200");

    // 9. Verify deletion in DB (metadata removed)
    console.log("\n[Test 8] Verify Project Is Gone");
    const verifyGetRes = await fetch(`${baseUrl}/api/projects/${createdProject?.id}`);
    assert(verifyGetRes.status === 404, "Deleted project returns 404 on subsequent GET");

    // 10. Delete already deleted project returns 404
    const deleteAgainRes = await fetch(`${baseUrl}/api/projects/${createdProject?.id}`, {
      method: "DELETE"
    });
    assert(deleteAgainRes.status === 404, "Deleting nonexistent project returns 404");

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
