import {
  createEmptyTimeline,
  addTrack,
  addClip,
  type Timeline,
  type MediaAsset,
  type AgentEditingPlan,
  type ProposedOperation,
  executeEditingPlan,
  getTimelineRevision
} from "./index.js";

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export function runExecutionEngineTests(): { passed: number; failed: number } {
  console.log("\n=== Step 6.4.2 Shared Execution Engine Test Suite ===");
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

  const mockAsset: MediaAsset = {
    id: "asset_test_1",
    projectId: "proj_exec",
    originalName: "camera_1.mp4",
    fileSize: 1048576,
    mimeType: "video/mp4",
    duration: 60.0,
    width: 1920,
    height: 1080,
    frameRate: "30.00",
    videoCodec: "h264",
    audioCodec: "aac",
    format: "mov,mp4",
    createdAt: new Date().toISOString()
  };

  function createBaseTestTimeline(revision: number = 1): Timeline {
    let tl = createEmptyTimeline({ projectId: "proj_exec", id: "tl_exec_base", revision });
    tl = addTrack(tl, { id: "tr_vid_1", name: "Video 1", type: "video" });
    tl = addClip(tl, {
      id: "clip_1",
      assetId: mockAsset.id,
      trackId: "tr_vid_1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      name: "Clip 1"
    });
    return tl;
  }

  // 1. Successful Single Operations
  console.log("\n[Test 1] Single Operation Execution");
  {
    // 1.1 split_clip
    const baseTl = createBaseTestTimeline();
    const splitPlan: AgentEditingPlan = {
      id: "plan_split",
      requestId: "req_1",
      projectId: "proj_exec",
      summary: "Split clip 1 at 4.0s",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_split_1",
          type: "split_clip",
          description: "Split at 4.0s",
          clipId: "clip_1",
          params: { splitTime: 4.0, newClipId: "clip_1_part2" }
        }
      ]
    };
    const res = executeEditingPlan(baseTl, splitPlan);
    assert(res.success === true, "Single split_clip succeeds");
    if (res.success) {
      assert(res.operationsApplied === 1, "Split applied count is 1");
      const clips = res.timeline.tracks[0].clips;
      assert(clips.length === 2, "Track has 2 clips after split");
      assert(clips[0].id === "clip_1" && clips[0].sourceEnd === 4, "First segment ends at 4.0s");
      assert(clips[1].id === "clip_1_part2" && clips[1].sourceStart === 4, "Second segment starts at 4.0s");
    }

    // 1.2 trim_clip (edge: left)
    const trimPlan: AgentEditingPlan = {
      id: "plan_trim",
      requestId: "req_2",
      projectId: "proj_exec",
      summary: "Trim left edge to 2.0s",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_trim_1",
          type: "trim_clip",
          description: "Trim left",
          clipId: "clip_1",
          params: { edge: "left", newTimelineTime: 2.0 }
        }
      ]
    };
    const trimRes = executeEditingPlan(baseTl, trimPlan);
    assert(trimRes.success === true, "Single trim_clip succeeds");
    if (trimRes.success) {
      const c = trimRes.timeline.tracks[0].clips[0];
      assert(c.timelineStart === 2.0 && c.sourceStart === 2.0, "Left trim updated timelineStart and sourceStart");
    }

    // 1.3 move_clip
    const movePlan: AgentEditingPlan = {
      id: "plan_move",
      requestId: "req_3",
      projectId: "proj_exec",
      summary: "Move clip to 5.0s",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_move_1",
          type: "move_clip",
          description: "Move to 5s",
          clipId: "clip_1",
          params: { newTimelineStart: 5.0 }
        }
      ]
    };
    const moveRes = executeEditingPlan(baseTl, movePlan);
    assert(moveRes.success === true, "Single move_clip succeeds");
    if (moveRes.success) {
      assert(moveRes.timeline.tracks[0].clips[0].timelineStart === 5.0, "Clip moved to 5.0s");
    }

    // 1.4 delete_clip
    const delPlan: AgentEditingPlan = {
      id: "plan_del",
      requestId: "req_4",
      projectId: "proj_exec",
      summary: "Delete clip",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_del_1",
          type: "delete_clip",
          description: "Delete clip",
          clipId: "clip_1",
          params: {}
        }
      ]
    };
    const delRes = executeEditingPlan(baseTl, delPlan);
    assert(delRes.success === true, "Single delete_clip succeeds");
    if (delRes.success) {
      assert(delRes.timeline.tracks[0].clips.length === 0, "Track is empty after delete");
    }
  }

  // 2. Successful Multi-Operation Sequential Execution
  console.log("\n[Test 2] Multi-Operation Sequential Execution");
  {
    const baseTl = createBaseTestTimeline();
    const multiPlan: AgentEditingPlan = {
      id: "plan_multi",
      requestId: "req_multi",
      projectId: "proj_exec",
      summary: "Sequential trim, split, and move",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        // Step 1: Trim clip_1 sourceStart from 0 to 2
        {
          id: "op_m1",
          type: "trim_clip",
          description: "Trim start lag",
          clipId: "clip_1",
          timeRange: { sourceStart: 2.0 },
          params: { sourceStart: 2.0 }
        },
        // Step 2: Split clip_1 at timeline 5.0s (source is 2..10, timeline is 2..10, so split at 5.0 is valid)
        {
          id: "op_m2",
          type: "split_clip",
          description: "Split at 5.0s",
          clipId: "clip_1",
          params: { splitTime: 5.0, newClipId: "clip_1_tail" }
        },
        // Step 3: Move the second segment to 10.0s
        {
          id: "op_m3",
          type: "move_clip",
          description: "Move second segment to 10.0s",
          clipId: "clip_1_tail",
          params: { newTimelineStart: 10.0 }
        }
      ]
    };
    const res = executeEditingPlan(baseTl, multiPlan);
    assert(res.success === true, "Multi-operation sequential plan succeeds");
    if (res.success) {
      assert(res.operationsApplied === 3, "All 3 operations applied");
      const clips = res.timeline.tracks[0].clips;
      assert(clips.length === 2, "Result has 2 clips");
      assert(clips[0].timelineStart === 2.0 && clips[0].sourceEnd === 5.0, "First segment is [2..5]");
      assert(clips[1].id === "clip_1_tail" && clips[1].timelineStart === 10.0, "Second segment moved to 10.0s");
    }
  }

  // 3. Operation targeting a clip created by an earlier operation
  console.log("\n[Test 3] Target Created By Earlier Operation");
  {
    const baseTl = createBaseTestTimeline();
    const plan: AgentEditingPlan = {
      id: "plan_chain",
      requestId: "req_chain",
      projectId: "proj_exec",
      summary: "Split and delete new clip",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_c1",
          type: "split_clip",
          description: "Split clip_1",
          clipId: "clip_1",
          params: { splitTime: 5.0, newClipId: "spawned_clip_99" }
        },
        {
          id: "op_c2",
          type: "delete_clip",
          description: "Delete the newly spawned segment",
          clipId: "spawned_clip_99",
          params: {}
        }
      ]
    };
    const res = executeEditingPlan(baseTl, plan);
    assert(res.success === true, "Can delete a clip created by a prior split in same plan");
    if (res.success) {
      const clips = res.timeline.tracks[0].clips;
      assert(clips.length === 1, "Only first segment remains");
      assert(clips[0].id === "clip_1", "Remaining clip is clip_1");
    }
  }

  // 4. Invalid operation in middle of plan aborts all execution
  console.log("\n[Test 4] Atomic Abort on Middle Operation Failure");
  {
    const baseTl = createBaseTestTimeline(5);
    const planWithBadMiddle: AgentEditingPlan = {
      id: "plan_fail_middle",
      requestId: "req_fail_middle",
      projectId: "proj_exec",
      summary: "Plan with invalid middle operation",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_ok1",
          type: "split_clip",
          description: "Valid split",
          clipId: "clip_1",
          params: { splitTime: 4.0, newClipId: "clip_1_mid" }
        },
        {
          id: "op_bad2",
          type: "trim_clip",
          description: "Invalid trim on nonexistent clip",
          clipId: "nonexistent_ghost_clip",
          params: { edge: "left", newTimelineTime: 1.0 }
        },
        {
          id: "op_ok3",
          type: "delete_clip",
          description: "Valid delete",
          clipId: "clip_1",
          params: {}
        }
      ]
    };
    const res = executeEditingPlan(baseTl, planWithBadMiddle);
    assert(res.success === false, "Execution fails when middle operation fails");
    if (!res.success) {
      assert(res.failedOperationIndex === 1, "Failed operation index is 1");
      assert(res.failedOperationId === "op_bad2", "Failed operation ID matches");
      assert(res.operationsApplied === 1, "Operations applied count before failure was 1");
      assert(res.timeline === baseTl, "Returned timeline is exact original instance");
      assert(res.timeline.tracks[0].clips.length === 1, "Original timeline has exactly 1 clip (NOT split)");
      assert(res.timeline.tracks[0].clips[0].sourceEnd === 10, "Original clip sourceEnd unmodified");
    }
  }

  // 5. Invalid clip/track references rejected
  console.log("\n[Test 5] Invalid References Rejection");
  {
    const baseTl = createBaseTestTimeline();
    const badRefPlan: AgentEditingPlan = {
      id: "plan_bad_ref",
      requestId: "req_bad_ref",
      projectId: "proj_exec",
      summary: "Invalid track move",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_bad_track",
          type: "move_clip",
          description: "Move to nonexistent track",
          clipId: "clip_1",
          params: { newTimelineStart: 2.0, newTrackId: "nonexistent_track_99" }
        }
      ]
    };
    const res = executeEditingPlan(baseTl, badRefPlan);
    assert(res.success === false, "Move to nonexistent track fails");
    if (!res.success) {
      assert(res.error.includes("nonexistent_track_99"), "Error message mentions bad track");
      assert(res.timeline === baseTl, "Original timeline returned");
    }
  }

  // 6. Revision preserved by pure engine
  console.log("\n[Test 6] Revision Invariant Preserved");
  {
    const tlWithRev = createBaseTestTimeline(17);
    assert(tlWithRev.revision === 17, "Initial timeline revision is 17");

    const validPlan: AgentEditingPlan = {
      id: "plan_rev_check",
      requestId: "req_rev",
      projectId: "proj_exec",
      summary: "Split preserving revision",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_r1",
          type: "split_clip",
          description: "Split",
          clipId: "clip_1",
          params: { splitTime: 5.0 }
        }
      ]
    };

    const resSuccess = executeEditingPlan(tlWithRev, validPlan);
    assert(resSuccess.success === true, "Plan succeeds");
    if (resSuccess.success) {
      assert(resSuccess.timeline.revision === 17, "Revision is strictly 17 after execution (not incremented)");
      assert(getTimelineRevision(resSuccess.timeline) === 17, "getTimelineRevision returns 17");
    }

    const failingPlan: AgentEditingPlan = {
      id: "plan_rev_fail",
      requestId: "req_rev_f",
      projectId: "proj_exec",
      summary: "Bad plan",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_bad",
          type: "delete_clip",
          description: "Bad delete",
          clipId: "ghost_clip",
          params: {}
        }
      ]
    };
    const resFail = executeEditingPlan(tlWithRev, failingPlan);
    assert(resFail.success === false, "Plan fails");
    assert(resFail.timeline.revision === 17, "Revision is preserved on failure");
  }

  // 7. Original timeline is unchanged after success and failure (Deep Freeze)
  console.log("\n[Test 7] Deep Immutability & Reference Isolation");
  {
    const baseTl = createBaseTestTimeline(3);
    deepFreeze(baseTl); // Will throw TypeError if any property is mutated!

    const successPlan: AgentEditingPlan = {
      id: "plan_freeze_ok",
      requestId: "req_f1",
      projectId: "proj_exec",
      summary: "Split on frozen timeline",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_f_split",
          type: "split_clip",
          description: "Split",
          clipId: "clip_1",
          params: { splitTime: 5.0, newClipId: "clip_new_frz" }
        }
      ]
    };

    let threwOnSuccess = false;
    try {
      const res = executeEditingPlan(baseTl, successPlan);
      assert(res.success === true, "Execution succeeded without mutating frozen input timeline");
    } catch {
      threwOnSuccess = true;
    }
    assert(!threwOnSuccess, "executeEditingPlan never mutates input on success");

    const failPlan: AgentEditingPlan = {
      id: "plan_freeze_fail",
      requestId: "req_f2",
      projectId: "proj_exec",
      summary: "Failing plan on frozen timeline",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_f_bad",
          type: "split_clip",
          description: "Split invalid position",
          clipId: "clip_1",
          params: { splitTime: 99.0 }
        }
      ]
    };

    let threwOnFailure = false;
    try {
      const res = executeEditingPlan(baseTl, failPlan);
      assert(res.success === false, "Execution failed as expected without mutation");
    } catch {
      threwOnFailure = true;
    }
    assert(!threwOnFailure, "executeEditingPlan never mutates input on failure");
  }

  // 8. Invalid final timeline is rejected
  console.log("\n[Test 8] Invalid Final Timeline Rejection");
  {
    // Setup timeline with video track and caption track, and provide mockAsset
    let tl = createEmptyTimeline({ projectId: "proj_exec", id: "tl_incompatible" });
    tl = addTrack(tl, { id: "tr_vid_1", name: "Video 1", type: "video" });
    tl = addTrack(tl, { id: "tr_cap_1", name: "Captions", type: "caption" });
    tl = addClip(tl, {
      id: "clip_v",
      assetId: mockAsset.id,
      trackId: "tr_vid_1",
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0
    });

    // Plan attempts to move video clip to caption track (incompatible stream type)
    const incompatiblePlan: AgentEditingPlan = {
      id: "plan_incompatible",
      requestId: "req_incompatible",
      projectId: "proj_exec",
      summary: "Move video to caption track",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_inc",
          type: "move_clip",
          description: "Move video to caption track",
          clipId: "clip_v",
          params: { newTimelineStart: 0, newTrackId: "tr_cap_1" }
        }
      ]
    };

    const res = executeEditingPlan(tl, incompatiblePlan, { assets: [mockAsset] });
    assert(res.success === false, "Plan that produces invalid timeline (stream incompatible track move) is rejected");
    if (!res.success) {
      assert(res.timeline === tl, "Returns original untouched timeline on invalid result");
      assert(res.timeline.tracks[0].clips.length === 1, "Original video track still has its clip");
      assert(res.timeline.tracks[1].clips.length === 0, "Caption track still empty");
    }
  }

  // 9. Valid Restricted Silence Removal
  console.log("\n[Test 9] Valid Restricted Silence Removal");
  {
    // Setup single track with 2 clips: Clip 1 [0..10s at t=0], Clip 2 [0..5s at t=15s]
    let tl = createEmptyTimeline({ projectId: "proj_exec", id: "tl_silence" });
    tl = addTrack(tl, { id: "tr_vid_1", name: "Video 1", type: "video" });
    tl = addClip(tl, {
      id: "clip_speech",
      assetId: mockAsset.id,
      trackId: "tr_vid_1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    tl = addClip(tl, {
      id: "clip_downstream",
      assetId: mockAsset.id,
      trackId: "tr_vid_1",
      sourceStart: 20,
      sourceEnd: 25,
      timelineStart: 15
    });

    // 9.1 Mid-clip silence removal with ripple
    // Silence at [3.0s, 6.0s] (duration 3.0s)
    const midSilencePlan: AgentEditingPlan = {
      id: "plan_sil_mid",
      requestId: "req_sm",
      projectId: "proj_exec",
      summary: "Remove silence [3..6s]",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_sm",
          type: "remove_silence",
          description: "Cut silence",
          clipId: "clip_speech",
          timeRange: { sourceStart: 3.0, sourceEnd: 6.0 },
          params: { start: 3.0, end: 6.0, newClipId: "clip_speech_p2" }
        }
      ]
    };

    const resMid = executeEditingPlan(tl, midSilencePlan);
    assert(resMid.success === true, "Mid-clip silence removal succeeds");
    if (resMid.success) {
      const clips = resMid.timeline.tracks[0].clips;
      assert(clips.length === 3, "Track now has 3 clips (piece1, piece2, downstream)");
      // Piece 1: source [0..3], timeline [0..3]
      assert(clips[0].id === "clip_speech" && clips[0].sourceStart === 0 && clips[0].sourceEnd === 3, "Piece 1 is [0..3]");
      assert(clips[0].timelineStart === 0, "Piece 1 starts at t=0");
      // Piece 2: source [6..10], timeline [3..7]
      assert(clips[1].id === "clip_speech_p2" && clips[1].sourceStart === 6 && clips[1].sourceEnd === 10, "Piece 2 is [6..10]");
      assert(clips[1].timelineStart === 3, "Piece 2 starts at t=3.0 (immediately after Piece 1)");
      // Downstream: originally at 15.0s, duration of silence is 3.0s -> rippled to 12.0s!
      assert(clips[2].id === "clip_downstream" && clips[2].timelineStart === 12.0, "Downstream clip rippled left from 15s to 12s");
    }

    // 9.2 Start-of-clip silence removal with ripple
    // Silence at [0.0s, 2.0s]
    const startSilencePlan: AgentEditingPlan = {
      id: "plan_sil_start",
      requestId: "req_ss",
      projectId: "proj_exec",
      summary: "Remove silence [0..2s]",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_ss",
          type: "remove_silence",
          description: "Cut intro silence",
          clipId: "clip_speech",
          params: { start: 0.0, end: 2.0 }
        }
      ]
    };
    const resStart = executeEditingPlan(tl, startSilencePlan);
    assert(resStart.success === true, "Start-of-clip silence removal succeeds");
    if (resStart.success) {
      const clips = resStart.timeline.tracks[0].clips;
      assert(clips.length === 2, "Track has 2 clips");
      assert(clips[0].sourceStart === 2.0 && clips[0].sourceEnd === 10.0, "Clip trimmed to [2..10]");
      // Downstream rippled left by 2.0s: 15s -> 13s
      assert(clips[1].timelineStart === 13.0, "Downstream clip rippled left from 15s to 13s");
    }

    // 9.3 End-of-clip silence removal with ripple
    // Silence at [8.0s, 10.0s]
    const endSilencePlan: AgentEditingPlan = {
      id: "plan_sil_end",
      requestId: "req_se",
      projectId: "proj_exec",
      summary: "Remove silence [8..10s]",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_se",
          type: "remove_silence",
          description: "Cut outro silence",
          clipId: "clip_speech",
          params: { start: 8.0, end: 10.0 }
        }
      ]
    };
    const resEnd = executeEditingPlan(tl, endSilencePlan);
    assert(resEnd.success === true, "End-of-clip silence removal succeeds");
    if (resEnd.success) {
      const clips = resEnd.timeline.tracks[0].clips;
      assert(clips.length === 2, "Track has 2 clips");
      assert(clips[0].sourceStart === 0 && clips[0].sourceEnd === 8.0, "Clip trimmed to [0..8]");
      // Downstream rippled left by 2.0s: 15s -> 13s
      assert(clips[1].timelineStart === 13.0, "Downstream clip rippled left from 15s to 13s");
    }

    // 9.4 Entire clip is silence
    const fullSilencePlan: AgentEditingPlan = {
      id: "plan_sil_full",
      requestId: "req_sf",
      projectId: "proj_exec",
      summary: "Remove entire clip silence [0..10s]",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_sf",
          type: "remove_silence",
          description: "Cut full clip",
          clipId: "clip_speech",
          params: { start: 0.0, end: 10.0 }
        }
      ]
    };
    const resFull = executeEditingPlan(tl, fullSilencePlan);
    assert(resFull.success === true, "Full clip silence removal succeeds");
    if (resFull.success) {
      const clips = resFull.timeline.tracks[0].clips;
      assert(clips.length === 1, "Track has 1 clip remaining");
      assert(clips[0].id === "clip_downstream", "Remaining clip is downstream");
      // Downstream rippled left by 10.0s: 15s -> 5s
      assert(clips[0].timelineStart === 5.0, "Downstream clip rippled left from 15s to 5s");
    }
  }

  // 10. Silence removal rejects unsupported boundary/cross-track cases
  console.log("\n[Test 10] Silence Removal Unsupported Cases Rejection");
  {
    const baseTl = createBaseTestTimeline();

    // 10.1 Straddling bounds (beyond clip sourceEnd)
    const outOfBoundsPlan: AgentEditingPlan = {
      id: "plan_sil_oob",
      requestId: "req_oob",
      projectId: "proj_exec",
      summary: "Silence out of bounds",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_oob",
          type: "remove_silence",
          description: "Straddle bounds",
          clipId: "clip_1",
          params: { start: 5.0, end: 15.0 } // clip_1 is [0..10]
        }
      ]
    };
    const resOob = executeEditingPlan(baseTl, outOfBoundsPlan);
    assert(resOob.success === false, "Silence removal straddling outside clip bounds is rejected");
    if (!resOob.success) {
      assert(resOob.error.includes("extends beyond clip"), "Error specifies bounds straddling");
    }

    // 10.2 Negative or reversed range
    const reversedPlan: AgentEditingPlan = {
      id: "plan_sil_rev",
      requestId: "req_rev_s",
      projectId: "proj_exec",
      summary: "Reversed silence interval",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_rev",
          type: "remove_silence",
          description: "Reversed",
          clipId: "clip_1",
          params: { start: 8.0, end: 4.0 }
        }
      ]
    };
    const resRev = executeEditingPlan(baseTl, reversedPlan);
    assert(resRev.success === false, "Silence removal with end <= start is rejected");

    // 10.3 Multi-track timeline rejection
    let multiTrackTl = createEmptyTimeline({ projectId: "proj_exec", id: "tl_multi_tr" });
    multiTrackTl = addTrack(multiTrackTl, { id: "tr_v", name: "Video", type: "video" });
    multiTrackTl = addTrack(multiTrackTl, { id: "tr_a", name: "Audio", type: "audio" });
    multiTrackTl = addClip(multiTrackTl, {
      id: "clip_v1",
      assetId: mockAsset.id,
      trackId: "tr_v",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });
    multiTrackTl = addClip(multiTrackTl, {
      id: "clip_a1",
      assetId: mockAsset.id,
      trackId: "tr_a",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });

    const multiTrackSilencePlan: AgentEditingPlan = {
      id: "plan_sil_mt",
      requestId: "req_mt",
      projectId: "proj_exec",
      summary: "Multi-track silence cut",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_mt_sil",
          type: "remove_silence",
          description: "Cut on multi-track",
          clipId: "clip_v1",
          params: { start: 2.0, end: 4.0 }
        }
      ]
    };
    const resMt = executeEditingPlan(multiTrackTl, multiTrackSilencePlan);
    assert(resMt.success === false, "Silence removal ripple rejected when multiple tracks contain clips");
    if (!resMt.success) {
      assert(resMt.error.includes("Multi-track ripple synchronization is not supported"), "Clear rejection for multi-track ripple");
    }
  }

  // 11. No accidental changes to unrelated tracks
  console.log("\n[Test 11] Unrelated Tracks Isolation");
  {
    // Create timeline with 2 tracks: Video 1 (has clip) and Captions 1 (empty)
    let tl = createEmptyTimeline({ projectId: "proj_exec", id: "tl_isolated" });
    tl = addTrack(tl, { id: "tr_v1", name: "Main Video", type: "video" });
    tl = addTrack(tl, { id: "tr_c1", name: "Captions", type: "caption" });
    tl = addClip(tl, {
      id: "clip_target",
      assetId: mockAsset.id,
      trackId: "tr_v1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0
    });

    const plan: AgentEditingPlan = {
      id: "plan_iso",
      requestId: "req_iso",
      projectId: "proj_exec",
      summary: "Split video track clip",
      status: "proposed",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: "op_iso_split",
          type: "split_clip",
          description: "Split",
          clipId: "clip_target",
          params: { splitTime: 5.0, newClipId: "clip_target_p2" }
        }
      ]
    };

    const res = executeEditingPlan(tl, plan);
    assert(res.success === true, "Execution succeeds");
    if (res.success) {
      const captionTrack = res.timeline.tracks.find((t) => t.id === "tr_c1");
      assert(Boolean(captionTrack), "Caption track still exists");
      assert(captionTrack?.clips.length === 0, "Caption track remained completely empty");
      assert(captionTrack?.type === "caption", "Caption track type preserved");
      assert(captionTrack?.name === "Captions", "Caption track name preserved");
    }
  }

  return { passed, failed };
}
