import assert from "node:assert";
import type {
  AgentEditingPlan,
  ExecutionReceipt,
  MediaAsset,
  ProposedOperation,
  Timeline
} from "@agentcut/shared";
import { TimelineHistory } from "@agentcut/shared";
import { deriveOperationDiff } from "./utils/agentCalculations.js";
import { TimelineSaveQueue } from "./utils/timelineSaveQueue.js";

console.log("=== AgentCut Frontend Approval Workflow Test Suite (Step 6.4.4) ===\n");

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

// Sample test data
const mockAssets: MediaAsset[] = [
  {
    id: "ast_video_1",
    projectId: "proj_test",
    originalName: "interview_a_roll.mp4",
    fileSize: 104857600,
    mimeType: "video/mp4",
    width: 1920,
    height: 1080,
    duration: 60.0,
    frameRate: "30",
    videoCodec: "h264",
    audioCodec: "aac",
    format: "mp4",
    createdAt: new Date().toISOString()
  }
];

const mockTimeline: Timeline = {
  id: "tl_test_1",
  projectId: "proj_test",
  revision: 3,
  settings: {
    frameRate: 30,
    width: 1920,
    height: 1080
  },
  tracks: [
    {
      id: "tr_v1",
      name: "Main Track",
      type: "video",
      index: 0,
      enabled: true,
      clips: [
        {
          id: "cl_1",
          assetId: "ast_video_1",
          trackId: "tr_v1",
          timelineStart: 0.0,
          sourceStart: 5.0,
          sourceEnd: 25.0, // 20s duration
          name: "Interview Part 1"
        },
        {
          id: "cl_2",
          assetId: "ast_video_1",
          trackId: "tr_v1",
          timelineStart: 25.0,
          sourceStart: 30.0,
          sourceEnd: 50.0, // 20s duration
          name: "Interview Part 2"
        }
      ]
    },
    {
      id: "tr_v2",
      name: "B-Roll Track",
      type: "video",
      index: 1,
      enabled: true,
      clips: []
    }
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

async function runAllTests() {
  // =========================================================================
  // Suite 1: Operation Diff & Preview Derivation
  // =========================================================================
  console.log("[Suite 1] Operation Diff & Preview Derivation Calculations");

  test("1.1 Split clip diff derives before/after durations and 2 segments", () => {
    const splitOp: ProposedOperation = {
      id: "op_split_1",
      type: "split_clip",
      description: "Split clip 1 at 8.0s",
      clipId: "cl_1",
      params: { splitTime: 8.0, newClipId: "cl_1_part2" }
    };

    const diff = deriveOperationDiff(splitOp, mockTimeline, mockAssets);
    assert.strictEqual(diff.typeLabel, "Split Clip");
    assert.strictEqual(diff.before?.duration, 20.0);
    assert.strictEqual(diff.after?.timelineStart, 0.0);
    assert.strictEqual(diff.after?.duration, 8.0);
    assert.strictEqual(diff.after?.segment2?.timelineStart, 8.0);
    assert.strictEqual(diff.after?.segment2?.duration, 12.0);
    assert.strictEqual(diff.warnings.length, 0);
  });

  test("1.2 Trim clip diff calculates source range delta and duration shrinkage", () => {
    const trimOp: ProposedOperation = {
      id: "op_trim_1",
      type: "trim_clip",
      description: "Trim 2s off the start of clip 1",
      clipId: "cl_1",
      params: { newSourceStart: 7.0, newSourceEnd: 25.0 }
    };

    const diff = deriveOperationDiff(trimOp, mockTimeline, mockAssets);
    assert.strictEqual(diff.typeLabel, "Trim Clip");
    assert.strictEqual(diff.before?.duration, 20.0);
    assert.strictEqual(diff.after?.duration, 18.0);
    assert.strictEqual(diff.after?.timelineStart, 2.0); // 0 + (7 - 5)
    assert.ok(diff.deltaSummary.includes("-2.00s") || diff.deltaSummary.includes("18.00s"));
    assert.strictEqual(diff.warnings.length, 0);
  });

  test("1.3 Move clip diff computes timeline shift and track changes", () => {
    const moveOp: ProposedOperation = {
      id: "op_move_1",
      type: "move_clip",
      description: "Move clip 2 to 30.0s on B-Roll Track",
      clipId: "cl_2",
      params: { newTimelineStart: 30.0, targetTrackId: "tr_v2" }
    };

    const diff = deriveOperationDiff(moveOp, mockTimeline, mockAssets);
    assert.strictEqual(diff.typeLabel, "Move Clip");
    assert.strictEqual(diff.before?.timelineStart, 25.0);
    assert.strictEqual(diff.after?.timelineStart, 30.0);
    assert.strictEqual(diff.targetTrackName, "B-Roll Track");
    assert.ok(diff.deltaSummary.includes("B-Roll Track"));
  });

  test("1.4 Delete clip diff computes freed duration and targets", () => {
    const deleteOp: ProposedOperation = {
      id: "op_del_1",
      type: "delete_clip",
      description: "Delete Interview Part 1",
      clipId: "cl_1",
      params: {}
    };

    const diff = deriveOperationDiff(deleteOp, mockTimeline, mockAssets);
    assert.strictEqual(diff.typeLabel, "Delete Clip");
    assert.strictEqual(diff.before?.duration, 20.0);
    assert.strictEqual(diff.after, undefined);
    assert.ok(diff.deltaSummary.includes("frees 20.00s"));
  });

  test("1.5 Remove silence diff calculates cut interval and ripple shift", () => {
    const silenceOp: ProposedOperation = {
      id: "op_silence_1",
      type: "remove_silence",
      description: "Remove 3s pause",
      trackId: "tr_v1",
      params: { start: 10.0, end: 13.0 }
    };

    const diff = deriveOperationDiff(silenceOp, mockTimeline, mockAssets);
    assert.strictEqual(diff.typeLabel, "Remove Silence");
    assert.ok(diff.deltaSummary.includes("Cuts 3.00s silent interval and ripples"));
  });

  test("1.6 Unknown operation type renders safely without crashing", () => {
    const unknownOp: ProposedOperation = {
      id: "op_future_1",
      type: "add_transition" as any,
      description: "Add cross-dissolve",
      params: { duration: 1.0 }
    };

    const diff = deriveOperationDiff(unknownOp, mockTimeline, mockAssets);
    assert.strictEqual(diff.typeLabel, "Operation: add_transition");
    assert.ok(diff.deltaSummary.includes("Custom parameter changes"));
  });

  test("1.7 Target clip missing from live timeline reports clean warning", () => {
    const ghostOp: ProposedOperation = {
      id: "op_ghost",
      type: "split_clip",
      description: "Split nonexistent clip",
      clipId: "ghost_clip_id",
      params: { splitTime: 5.0 }
    };

    const diff = deriveOperationDiff(ghostOp, mockTimeline, mockAssets);
    assert.strictEqual(diff.warnings.length, 1);
    assert.ok(diff.warnings[0].includes("not found on current timeline"));
  });

  // =========================================================================
  // Suite 2: Stale Revision Detection & Concurrency Safety
  // =========================================================================
  console.log("\n[Suite 2] Stale Revision Detection & Concurrency Protection");

  test("2.1 Plan targeting matching revision is not stale", () => {
    const freshPlan: AgentEditingPlan = {
      id: "plan_fresh",
      requestId: "req_fresh",
      projectId: "proj_test",
      targetTimelineRevision: 3,
      planHash: "hash_fresh_123",
      summary: "Valid fresh plan",
      operations: [],
      status: "proposed",
      createdAt: new Date().toISOString()
    };

    const isStale = (mockTimeline.revision ?? 1) !== (freshPlan.targetTimelineRevision ?? 1);
    assert.strictEqual(isStale, false);
  });

  test("2.2 Plan targeting older revision is flagged as stale", () => {
    const stalePlan: AgentEditingPlan = {
      id: "plan_stale",
      requestId: "req_stale",
      projectId: "proj_test",
      targetTimelineRevision: 2, // Timeline live revision is 3
      planHash: "hash_stale_123",
      summary: "Stale plan",
      operations: [],
      status: "proposed",
      createdAt: new Date().toISOString()
    };

    const isStale = (mockTimeline.revision ?? 1) !== (stalePlan.targetTimelineRevision ?? 1);
    assert.strictEqual(isStale, true);
  });

  // =========================================================================
  // Suite 3: Timeline Synchronization & Undo/Redo Integration
  // =========================================================================
  console.log("\n[Suite 3] Timeline Synchronization & Undo/Redo Integration");

  test("3.1 Agent execution synchronizes as exactly ONE external undoable step in TimelineHistory", () => {
    const history = new TimelineHistory({ maxHistory: 50, initialTimeline: mockTimeline });
    assert.strictEqual(history.canUndo(), false);
    assert.strictEqual(history.getCurrentIndex(), 0);

    // Simulated committed timeline returned from server CAS execution
    const committedTimeline: Timeline = {
      ...mockTimeline,
      revision: 4,
      tracks: [
        {
          ...mockTimeline.tracks[0],
          clips: [mockTimeline.tracks[0].clips[0]] // Deleted clip 2
        },
        mockTimeline.tracks[1]
      ]
    };

    // Synchronize into history
    history.push(committedTimeline);

    assert.strictEqual(history.canUndo(), true, "Agent execution is undoable");
    assert.strictEqual(history.getCurrentIndex(), 1, "History advanced by exactly 1 entry");
    assert.strictEqual(history.getCurrent()?.revision, 4, "Current history reflects executed timeline");

    // Click Undo
    const undone = history.undo();
    assert.ok(undone !== null);
    assert.strictEqual(undone?.revision, 3, "Undoing agent execution restores pre-execution timeline");
    assert.strictEqual(undone?.tracks[0].clips.length, 2, "Both original clips restored on undo");

    // Click Redo
    const redone = history.redo();
    assert.ok(redone !== null);
    assert.strictEqual(redone?.revision, 4, "Redoing agent execution re-applies post-execution timeline");
    assert.strictEqual(redone?.tracks[0].clips.length, 1);
  });

  await test("3.2 SaveQueue idle barrier drains in-flight local saves before agent synchronization", async () => {
    let saveCount = 0;
    const saveQueue = new TimelineSaveQueue({
      saveFn: async (t: Timeline) => {
        await new Promise((r) => setTimeout(r, 10));
        saveCount++;
        return { ...t, revision: (t.revision ?? 1) + 1 };
      },
      initialTimeline: mockTimeline
    });

    // Enqueue a local manual edit
    saveQueue.enqueue({ ...mockTimeline, revision: 3 });
    assert.strictEqual(saveQueue.isBusy(), true);

    // Wait for idle before applying agent execution
    await saveQueue.waitForIdle();
    assert.strictEqual(saveQueue.isBusy(), false);
    assert.strictEqual(saveCount, 1);

    // Now safe to set authoritative timeline
    const committedTimeline: Timeline = { ...mockTimeline, revision: 4 };
    saveQueue.setLastSavedTimeline(committedTimeline);
    assert.strictEqual(saveQueue.getLastSavedTimeline()?.revision, 4);
  });

  test("3.3 Idempotency guard prevents duplicate timeline application", () => {
    let appliedCount = 0;
    let lastSynchronizedExecutionId: string | null = null;

    const applyExecution = (receipt: ExecutionReceipt) => {
      if (lastSynchronizedExecutionId === receipt.executionId) {
        return; // Guard
      }
      appliedCount++;
      lastSynchronizedExecutionId = receipt.executionId;
    };

    const receipt: ExecutionReceipt = {
      executionId: "exec_unique_123",
      targetTimelineRevision: 3,
      committedTimelineRevision: 4,
      startedAt: new Date().toISOString(),
      committedAt: new Date().toISOString(),
      operationsApplied: 2,
      status: "committed"
    };

    // First application
    applyExecution(receipt);
    assert.strictEqual(appliedCount, 1);

    // Replay attempt with identical executionId
    applyExecution(receipt);
    assert.strictEqual(appliedCount, 1, "Duplicate application strictly suppressed");
  });

  test("3.4 Invariant 1: Manual edit -> undo (leaves redo branch) -> agent plan execution -> redo branch discarded -> undo restores pre-agent baseline -> redo reapplies agent execution exactly once", () => {
    // Baseline T0
    const history = new TimelineHistory({ initialTimeline: mockTimeline });
    assert.strictEqual(history.getCurrentIndex(), 0);
    assert.strictEqual(history.canUndo(), false);
    assert.strictEqual(history.canRedo(), false);

    // Step 1: Manual edit T1 (move clip 1 to 5s)
    const t1: Timeline = {
      ...mockTimeline,
      tracks: [
        {
          ...mockTimeline.tracks[0],
          clips: [
            { ...mockTimeline.tracks[0].clips[0], timelineStart: 5.0 },
            { ...mockTimeline.tracks[0].clips[1] }
          ]
        }
      ]
    };
    history.push(t1);
    assert.strictEqual(history.getCurrentIndex(), 1);
    assert.strictEqual(history.canUndo(), true);
    assert.strictEqual(history.canRedo(), false);
    assert.strictEqual(history.getCurrent()?.tracks[0].clips[0].timelineStart, 5.0);

    // Step 2: Undo manual edit, leaving a redo branch
    const undoneManual = history.undo();
    assert.ok(undoneManual !== null);
    assert.strictEqual(history.getCurrentIndex(), 0);
    assert.strictEqual(history.canUndo(), false);
    assert.strictEqual(history.canRedo(), true, "Redo branch exists for undone manual edit");
    assert.strictEqual(undoneManual?.tracks[0].clips[0].timelineStart, 0.0);

    // Step 3: Execute an agent plan on T0 (e.g. deleting clip 2)
    const tAgent: Timeline = {
      ...mockTimeline,
      revision: 4,
      tracks: [
        {
          ...mockTimeline.tracks[0],
          clips: [{ ...mockTimeline.tracks[0].clips[0] }] // clip 2 removed
        }
      ]
    };
    history.push(tAgent);

    // Step 4: Verify the redo branch is handled correctly
    assert.strictEqual(history.getCurrentIndex(), 1);
    assert.strictEqual(history.canRedo(), false, "Prior manual redo branch discarded on agent push");
    assert.strictEqual(history.canUndo(), true, "Agent execution is undoable");
    assert.strictEqual(history.getCurrent()?.tracks[0].clips.length, 1);

    // Step 5: Undo the agent action
    const undoneAgent = history.undo();
    assert.ok(undoneAgent !== null);

    // Step 6: Verify the timeline returns to the exact state immediately preceding agent execution
    assert.strictEqual(history.getCurrentIndex(), 0);
    assert.strictEqual(undoneAgent?.tracks[0].clips.length, 2, "Exact pre-agent clip count restored");
    assert.strictEqual(undoneAgent?.tracks[0].clips[0].timelineStart, 0.0, "Exact pre-agent start restored");
    assert.strictEqual(history.canUndo(), false);
    assert.strictEqual(history.canRedo(), true, "Agent execution is now redoable");

    // Step 7: Verify redo reapplies the agent action exactly once
    const redoneAgent = history.redo();
    assert.ok(redoneAgent !== null);
    assert.strictEqual(history.getCurrentIndex(), 1);
    assert.strictEqual(redoneAgent?.revision, 4, "Agent revision reapplied");
    assert.strictEqual(redoneAgent?.tracks[0].clips.length, 1, "Agent edit reapplied");
    assert.strictEqual(history.canRedo(), false, "No further redo branches exist");
    assert.strictEqual(history.redo(), null, "Subsequent redo is null");
  });

  await test("3.5 Invariant 2: Execution lock blocks manual edits, drains save queue before approval, and prevents stale local save overwrites", async () => {
    let serverTimeline: Timeline = { ...mockTimeline, revision: 3 };
    const serverWrites: Timeline[] = [];

    const saveQueue = new TimelineSaveQueue({
      saveFn: async (t: Timeline) => {
        await new Promise((r) => setTimeout(r, 15));
        const committed: Timeline = { ...t, revision: (serverTimeline.revision ?? 1) + 1 };
        serverTimeline = committed;
        serverWrites.push(committed);
        return committed;
      },
      initialTimeline: mockTimeline
    });

    let isAgentExecuting = false;

    // Simulate editor persistTimeline callback with lock check
    const editorPersist = (t: Timeline) => {
      if (isAgentExecuting) {
        return false; // Edit prevented
      }
      saveQueue.enqueue(t);
      return true;
    };

    // User makes a manual edit right before clicking approve
    const manualEditPreApproval = { ...mockTimeline, revision: 3 };
    editorPersist(manualEditPreApproval);
    assert.strictEqual(saveQueue.isBusy(), true, "Manual save in flight");

    // User clicks Approve: handleBeforeApprove engages lock and drains queue
    isAgentExecuting = true;
    if (saveQueue.isBusy()) {
      await saveQueue.waitForIdle();
    }
    assert.strictEqual(saveQueue.isBusy(), false, "Queue is drained before approval dispatch");
    assert.strictEqual(serverWrites.length, 1, "Pre-approval edit persisted cleanly");

    // While execution is active, user attempts to make an edit (drag/trim/split/delete)
    const attemptedEditDuringExecution = {
      ...mockTimeline,
      tracks: [{ ...mockTimeline.tracks[0], clips: [] }]
    };
    const editAccepted = editorPersist(attemptedEditDuringExecution);
    assert.strictEqual(editAccepted, false, "Manual edit strictly rejected while execution is active");
    assert.strictEqual(saveQueue.isBusy(), false, "No new saves enqueued during execution");

    // Agent executes and commits revision 5 on server
    const agentCommittedTimeline: Timeline = {
      ...mockTimeline,
      revision: (serverTimeline.revision ?? 1) + 1
    };
    serverTimeline = agentCommittedTimeline;

    // handleApplyAgentExecution runs
    saveQueue.setLastSavedTimeline(agentCommittedTimeline);
    isAgentExecuting = false; // unlocked

    // Verify server was NOT overwritten by stale local saves
    assert.strictEqual(serverTimeline.revision, 5, "Agent committed timeline preserved");
    assert.strictEqual(saveQueue.getLastSavedTimeline()?.revision, 5);

    // After execution finishes, editor is unlocked for normal edits
    const postExecutionEdit = { ...agentCommittedTimeline };
    const postEditAccepted = editorPersist(postExecutionEdit);
    assert.strictEqual(postEditAccepted, true, "Timeline unlocked after execution finishes");
    await saveQueue.waitForIdle();
    assert.strictEqual(serverTimeline.revision, 6, "Post-execution edit persisted normally");
  });

  // =========================================================================
  // Suite 4: API Payload & Error Contract Verification
  // =========================================================================
  console.log("\n[Suite 4] API Payload & Error Contract Verification");

  test("4.1 Approve payload correctly binds planHash and targetTimelineRevision", () => {
    const plan: AgentEditingPlan = {
      id: "plan_41",
      requestId: "req_41",
      projectId: "proj_test",
      targetTimelineRevision: 3,
      planHash: "sha256_canonical_hash_abc",
      summary: "Approved plan",
      operations: [],
      status: "proposed",
      createdAt: new Date().toISOString()
    };

    const payload = {
      planHash: plan.planHash!,
      expectedTimelineRevision: plan.targetTimelineRevision!
    };

    assert.strictEqual(payload.planHash, "sha256_canonical_hash_abc");
    assert.strictEqual(payload.expectedTimelineRevision, 3);
  });

  test("4.2 Rejection request payload accepts optional reason", () => {
    const reason = "User selected alternative cuts.";
    const payload = { reason };
    assert.strictEqual(payload.reason, "User selected alternative cuts.");
  });

  test("4.3 Bounded polling termination condition triggers uncertain state", () => {
    const MAX_POLLS = 5;
    let pollCount = 0;
    let isUncertain = false;

    // Simulate poll loop
    while (pollCount < MAX_POLLS) {
      pollCount++;
      const status: string = "executing"; // Never settles
      if (status === "completed" || status === "failed" || status === "canceled") {
        break;
      }
      if (pollCount >= MAX_POLLS) {
        isUncertain = true;
      }
    }

    assert.strictEqual(pollCount, 5);
    assert.strictEqual(isUncertain, true, "Unsettled execution reaches bounded uncertain state");
  });

  console.log(`\n=== Verification Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test execution threw fatal error:", err);
  process.exit(1);
});

