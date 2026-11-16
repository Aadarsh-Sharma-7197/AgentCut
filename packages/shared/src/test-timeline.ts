import {
  createEmptyTimeline,
  addTrack,
  addClip,
  removeClip,
  deleteClip,
  moveClip,
  splitClip,
  splitClipWithResult,
  trimClip,
  renameTrack,
  reorderTrack,
  moveTrackOrder,
  deleteTrack,
  generateDefaultTrackName,
  validateTimeline,
  validateClip,
  validateTrack,
  getClipDuration,
  getClipTimelineEnd,
  getTimelineDuration,
  TimelineValidationError,
  TimelineHistory,
  cloneTimeline,
  areTimelinesEquivalent,
  timelineTimeToSourceTime,
  sourceTimeToTimelineTime,
  isTimelineTimeInsideClip,
  findActiveVideoClipAtTime,
  findNextVideoClipAfterTime,
  getTimelinePlaybackSnapshot,
  type Timeline,
  type MediaAsset
} from "./index.js";
import { runRenderTests } from "./test-render.js";

function runTimelineTests() {
  console.log("=== AgentCut Timeline Data Model Test Suite ===");
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

  // Mock media assets for asset validation
  const videoAsset: MediaAsset = {
    id: "asset_video_1",
    projectId: "proj_123",
    originalName: "camera_a.mp4",
    fileSize: 10485760,
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

  const audioOnlyAsset: MediaAsset = {
    id: "asset_audio_1",
    projectId: "proj_123",
    originalName: "voiceover.m4a",
    fileSize: 2048000,
    mimeType: "audio/mp4",
    duration: 30.0,
    width: 0,
    height: 0,
    frameRate: "0",
    videoCodec: "",
    audioCodec: "aac",
    format: "mov,mp4",
    createdAt: new Date().toISOString()
  };

  const captionAsset: MediaAsset = {
    id: "asset_caption_1",
    projectId: "proj_123",
    originalName: "subtitles.vtt",
    fileSize: 12000,
    mimeType: "text/vtt",
    duration: 60.0,
    width: 0,
    height: 0,
    frameRate: "0",
    videoCodec: "",
    audioCodec: null,
    format: "vtt",
    createdAt: new Date().toISOString()
  };

  const assetsCatalog: MediaAsset[] = [videoAsset, audioOnlyAsset, captionAsset];

  // 1. Empty timeline creation
  console.log("\n[Test 1] Empty Timeline Creation");
  const emptyTimeline = createEmptyTimeline({
    projectId: "proj_123",
    id: "tl_custom_1",
    settings: { frameRate: 30, width: 1920, height: 1080 }
  });
  assert(emptyTimeline.id === "tl_custom_1", "Timeline ID is set correctly");
  assert(emptyTimeline.projectId === "proj_123", "Project ID is set correctly");
  assert(emptyTimeline.tracks.length === 0, "Initial tracks array is empty");
  assert(emptyTimeline.settings.frameRate === 30, "Settings frame rate is 30 fps");
  assert(Boolean(emptyTimeline.createdAt), "createdAt timestamp is present");
  assert(Boolean(emptyTimeline.updatedAt), "updatedAt timestamp is present");

  // 2. Track creation
  console.log("\n[Test 2] Track Creation (Immutable)");
  const withVideoTrack = addTrack(emptyTimeline, {
    id: "track_v1",
    name: "Video 1",
    type: "video"
  });
  assert(withVideoTrack.tracks.length === 1, "Track added to new timeline");
  assert(withVideoTrack.tracks[0].id === "track_v1", "Track ID matches input");
  assert(withVideoTrack.tracks[0].name === "Video 1", "Track name matches input");
  assert(withVideoTrack.tracks[0].type === "video", "Track type is video");
  assert(withVideoTrack.tracks[0].clips.length === 0, "Track starts with 0 clips");
  assert(emptyTimeline.tracks.length === 0, "Original empty timeline was NOT mutated");

  const withAudioTrack = addTrack(withVideoTrack, {
    id: "track_a1",
    name: "Audio 1",
    type: "audio"
  });
  assert(withAudioTrack.tracks.length === 2, "Second track added");
  assert(withAudioTrack.tracks[1].id === "track_a1", "Track 2 ID matches");

  const withCaptionTrack = addTrack(withAudioTrack, {
    id: "track_c1",
    name: "Captions 1",
    type: "caption"
  });
  assert(withCaptionTrack.tracks.length === 3, "Caption track added");
  assert(withCaptionTrack.tracks[2].type === "caption", "Track 3 type is caption");

  // 3. Clip creation & derived duration
  console.log("\n[Test 3] Clip Creation & Timing Derivation");
  const withClip1 = addClip(withCaptionTrack, {
    id: "clip_v1_1",
    assetId: videoAsset.id,
    trackId: "track_v1",
    sourceStart: 5.0,
    sourceEnd: 15.0,
    timelineStart: 0.0,
    name: "Intro Shot"
  });
  const addedClip = withClip1.tracks[0].clips[0];
  assert(Boolean(addedClip), "Clip added to video track");
  assert(addedClip.id === "clip_v1_1", "Clip ID matches");
  assert(addedClip.sourceStart === 5.0, "sourceStart is 5.0s");
  assert(addedClip.sourceEnd === 15.0, "sourceEnd is 15.0s");
  assert(addedClip.timelineStart === 0.0, "timelineStart is 0.0s");
  assert(getClipDuration(addedClip) === 10.0, "Derived clip duration is 10.0s (15 - 5)");
  assert(getClipTimelineEnd(addedClip) === 10.0, "Derived clip timeline end is 10.0s (0 + 10)");
  assert(getTimelineDuration(withClip1) === 10.0, "Timeline total duration is 10.0s");
  assert(withCaptionTrack.tracks[0].clips.length === 0, "Previous timeline object was NOT mutated");

  // 4. Duplicate track IDs rejection
  console.log("\n[Test 4] Duplicate Track IDs Rejection");
  let dupTrackThrew = false;
  try {
    addTrack(withCaptionTrack, {
      id: "track_v1", // already exists
      name: "Another Video Track",
      type: "video"
    });
  } catch {
    dupTrackThrew = true;
  }
  assert(dupTrackThrew, "addTrack throws on duplicate track ID");

  // 5. Duplicate clip IDs rejection
  console.log("\n[Test 5] Duplicate Clip IDs Rejection");
  let dupClipThrew = false;
  try {
    addClip(withClip1, {
      id: "clip_v1_1", // already exists
      assetId: videoAsset.id,
      trackId: "track_a1",
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0
    });
  } catch {
    dupClipThrew = true;
  }
  assert(dupClipThrew, "addClip throws on duplicate clip ID");

  // 6. Invalid source timing checks
  console.log("\n[Test 6] Invalid Source Timing Rejections");
  let invTimingThrew = false;
  try {
    addClip(withClip1, {
      id: "clip_invalid_1",
      assetId: videoAsset.id,
      trackId: "track_v1",
      sourceStart: 10.0,
      sourceEnd: 5.0, // Invalid: end < start
      timelineStart: 10.0
    });
  } catch {
    invTimingThrew = true;
  }
  assert(invTimingThrew, "addClip throws when sourceEnd <= sourceStart");

  let equalTimingThrew = false;
  try {
    addClip(withClip1, {
      id: "clip_invalid_2",
      assetId: videoAsset.id,
      trackId: "track_v1",
      sourceStart: 5.0,
      sourceEnd: 5.0, // Invalid: end == start (0 duration)
      timelineStart: 10.0
    });
  } catch {
    equalTimingThrew = true;
  }
  assert(equalTimingThrew, "addClip throws when sourceEnd === sourceStart");

  let negSourceThrew = false;
  try {
    addClip(withClip1, {
      id: "clip_invalid_3",
      assetId: videoAsset.id,
      trackId: "track_v1",
      sourceStart: -2.0, // Invalid: negative
      sourceEnd: 5.0,
      timelineStart: 0.0
    });
  } catch {
    negSourceThrew = true;
  }
  assert(negSourceThrew, "addClip throws when sourceStart < 0");

  let nanTimingThrew = false;
  try {
    addClip(withClip1, {
      id: "clip_invalid_4",
      assetId: videoAsset.id,
      trackId: "track_v1",
      sourceStart: NaN,
      sourceEnd: 5.0,
      timelineStart: 0.0
    });
  } catch {
    nanTimingThrew = true;
  }
  assert(nanTimingThrew, "addClip throws when timing is NaN");

  // 7. Negative timeline positions
  console.log("\n[Test 7] Negative Timeline Position Rejection");
  let negTimelineStartThrew = false;
  try {
    addClip(withClip1, {
      id: "clip_invalid_5",
      assetId: videoAsset.id,
      trackId: "track_v1",
      sourceStart: 0.0,
      sourceEnd: 5.0,
      timelineStart: -1.5 // Invalid: negative timeline start
    });
  } catch {
    negTimelineStartThrew = true;
  }
  assert(negTimelineStartThrew, "addClip throws when timelineStart < 0");

  // 8. Missing track reference
  console.log("\n[Test 8] Missing Track Reference");
  let missingTrackThrew = false;
  try {
    addClip(withClip1, {
      id: "clip_invalid_6",
      assetId: videoAsset.id,
      trackId: "nonexistent_track_id",
      sourceStart: 0.0,
      sourceEnd: 5.0,
      timelineStart: 0.0
    });
  } catch {
    missingTrackThrew = true;
  }
  assert(missingTrackThrew, "addClip throws when target track does not exist");

  // 9. Media asset catalog validation in addClip & moveClip
  console.log("\n[Test 9] Media Asset Catalog Enforcement in Operations");
  // addClip with nonexistent asset when asset catalog is passed
  let missingAssetInAddClipThrew = false;
  try {
    addClip(
      withClip1,
      {
        id: "clip_ghost",
        assetId: "nonexistent_asset_id",
        trackId: "track_v1",
        sourceStart: 0.0,
        sourceEnd: 5.0,
        timelineStart: 12.0
      },
      { assets: assetsCatalog }
    );
  } catch (err) {
    if (err instanceof TimelineValidationError) {
      missingAssetInAddClipThrew = true;
    }
  }
  assert(missingAssetInAddClipThrew, "addClip with assets option rejects nonexistent assetId");

  // 10. Track / Clip Compatibility Rules (Video, Audio, and Caption)
  console.log("\n[Test 10] Track Compatibility Rules (Video, Audio, and Caption)");
  // Audio-only asset on Video track
  let audioOnVideoThrew = false;
  try {
    addClip(
      withClip1,
      {
        id: "clip_audio_on_video",
        assetId: audioOnlyAsset.id,
        trackId: "track_v1",
        sourceStart: 0.0,
        sourceEnd: 5.0,
        timelineStart: 15.0
      },
      { assets: assetsCatalog }
    );
  } catch (err) {
    if (err instanceof TimelineValidationError) {
      audioOnVideoThrew = true;
    }
  }
  assert(audioOnVideoThrew, "addClip rejects audio-only asset on video track when assets catalog provided");

  // Video asset on Caption track
  let videoOnCaptionThrew = false;
  try {
    addClip(
      withClip1,
      {
        id: "clip_video_on_caption",
        assetId: videoAsset.id,
        trackId: "track_c1",
        sourceStart: 0.0,
        sourceEnd: 5.0,
        timelineStart: 0.0
      },
      { assets: assetsCatalog }
    );
  } catch (err) {
    if (err instanceof TimelineValidationError) {
      videoOnCaptionThrew = true;
    }
  }
  assert(videoOnCaptionThrew, "addClip rejects video media asset on caption track");

  // Audio asset on Caption track
  let audioOnCaptionThrew = false;
  try {
    addClip(
      withClip1,
      {
        id: "clip_audio_on_caption",
        assetId: audioOnlyAsset.id,
        trackId: "track_c1",
        sourceStart: 0.0,
        sourceEnd: 5.0,
        timelineStart: 0.0
      },
      { assets: assetsCatalog }
    );
  } catch (err) {
    if (err instanceof TimelineValidationError) {
      audioOnCaptionThrew = true;
    }
  }
  assert(audioOnCaptionThrew, "addClip rejects audio media asset on caption track");

  // Subtitle/Caption asset on Caption track (valid!)
  const withValidCaption = addClip(
    withClip1,
    {
      id: "clip_valid_caption",
      assetId: captionAsset.id,
      trackId: "track_c1",
      sourceStart: 0.0,
      sourceEnd: 10.0,
      timelineStart: 0.0,
      name: "Scene 1 Subtitles"
    },
    { assets: assetsCatalog }
  );
  assert(
    withValidCaption.tracks.find((t) => t.id === "track_c1")?.clips.length === 1,
    "addClip accepts valid text/caption asset on caption track"
  );

  // 11. Move clip across tracks and compatibility enforcement
  console.log("\n[Test 11] Moving a Clip Between Tracks & Validation");
  // Moving video clip to another video track (Valid)
  const withTrackV2 = addTrack(withValidCaption, {
    id: "track_v2",
    name: "Video 2",
    type: "video"
  });
  const movedToV2 = moveClip(withTrackV2, "clip_v1_1", 2.5, "track_v2", { assets: assetsCatalog });
  const trackV2Clips = movedToV2.tracks.find((t) => t.id === "track_v2")!.clips;
  const trackV1Clips = movedToV2.tracks.find((t) => t.id === "track_v1")!.clips;
  assert(trackV1Clips.length === 0, "Clip was removed from track_v1");
  assert(trackV2Clips.length === 1, "Clip was placed on track_v2");
  assert(trackV2Clips[0].trackId === "track_v2", "Clip's trackId was updated to destination track 'track_v2'");
  assert(trackV2Clips[0].timelineStart === 2.5, "Clip's timelineStart was updated to 2.5s");

  // Moving video clip to caption track (Invalid compatibility -> should throw)
  let moveVideoToCaptionThrew = false;
  try {
    moveClip(withTrackV2, "clip_v1_1", 0.0, "track_c1", { assets: assetsCatalog });
  } catch (err) {
    if (err instanceof TimelineValidationError) {
      moveVideoToCaptionThrew = true;
    }
  }
  assert(moveVideoToCaptionThrew, "moveClip rejects moving video clip to caption track when assets catalog provided");

  // Moving video clip to negative position
  let negMoveThrew = false;
  try {
    moveClip(withTrackV2, "clip_v1_1", -1.0);
  } catch {
    negMoveThrew = true;
  }
  assert(negMoveThrew, "moveClip throws when newTimelineStart < 0");

  // 12. Remove clip
  console.log("\n[Test 12] Removing a Clip");
  const removedTimeline = removeClip(withClip1, "clip_v1_1");
  assert(removedTimeline.tracks[0].clips.length === 0, "Clip was removed from timeline");
  assert(withClip1.tracks[0].clips.length === 1, "Original timeline still has its clip");

  let removeGhostThrew = false;
  try {
    removeClip(withClip1, "ghost_clip_id");
  } catch {
    removeGhostThrew = true;
  }
  assert(removeGhostThrew, "removeClip throws when clip ID is not found");

  // 13. Deep Immutability & Reference Isolation Check
  console.log("\n[Test 13] Deep Immutability & Reference Isolation");
  const baseTimeline = createEmptyTimeline({
    projectId: "iso_proj",
    id: "tl_iso",
    settings: { frameRate: 24, width: 1920, height: 1080 }
  });
  const tTrack = addTrack(baseTimeline, { id: "tr_iso_1", name: "Original Track", type: "video" });
  const tClip = addClip(tTrack, {
    id: "cl_iso_1",
    assetId: videoAsset.id,
    trackId: "tr_iso_1",
    sourceStart: 0,
    sourceEnd: 5,
    timelineStart: 0,
    name: "Original Clip Name"
  });

  // Perform an operation
  const evolvedTimeline = moveClip(tClip, "cl_iso_1", 10.0);

  // Directly attempt to mutate the returned evolved timeline object in-place
  evolvedTimeline.settings.frameRate = 999;
  evolvedTimeline.tracks[0].name = "Mutated Track Name";
  evolvedTimeline.tracks[0].clips[0].name = "Mutated Clip Name";

  // Verify that the original tClip timeline was completely unaffected
  assert(tClip.settings.frameRate === 24, "Original settings.frameRate remained 24 after mutating returned timeline");
  assert(tClip.tracks[0].name === "Original Track", "Original track name remained unchanged after mutating returned timeline");
  assert(tClip.tracks[0].clips[0].name === "Original Clip Name", "Original clip name remained unchanged after mutating returned timeline");
  assert(tClip.tracks[0].clips[0].timelineStart === 0.0, "Original clip timelineStart remained 0.0s");

  // ==========================================
  // [Test 14] Split Clips Operations (14 Scenarios)
  // ==========================================
  console.log("\n[Test 14] Split Clip Operation — Comprehensive 14 Scenarios");

  // Helper setup for split tests
  const splitBaseTimeline = createEmptyTimeline({
    projectId: "split_proj_1",
    id: "tl_split_1",
    settings: { frameRate: 30, width: 1920, height: 1080 }
  });
  const splitTrackTimeline = addTrack(splitBaseTimeline, { id: "tr_split_v1", name: "Video Track 1", type: "video" });

  // 1. Splitting a clip at its midpoint
  const clip1Timeline = addClip(splitTrackTimeline, {
    id: "clip_midpoint",
    assetId: videoAsset.id,
    trackId: "tr_split_v1",
    sourceStart: 0,
    sourceEnd: 10,
    timelineStart: 0
  });
  const midpointResult = splitClipWithResult(clip1Timeline, "clip_midpoint", 5.0, { assets: [videoAsset] });
  assert(midpointResult.firstClip.id === "clip_midpoint", "Scenario 1: Midpoint split preserves first clip ID");
  assert(midpointResult.firstClip.sourceStart === 0 && midpointResult.firstClip.sourceEnd === 5.0, "Scenario 1: First clip source range is [0, 5.0]");
  assert(midpointResult.firstClip.timelineStart === 0, "Scenario 1: First clip timelineStart is 0.0");
  assert(midpointResult.secondClip.sourceStart === 5.0 && midpointResult.secondClip.sourceEnd === 10.0, "Scenario 1: Second clip source range is [5.0, 10.0]");
  assert(midpointResult.secondClip.timelineStart === 5.0, "Scenario 1: Second clip timelineStart is 5.0");

  // 2. Splitting at an arbitrary valid position (e.g. 3.7s)
  const arbitraryResult = splitClipWithResult(clip1Timeline, "clip_midpoint", 3.7, { assets: [videoAsset] });
  assert(arbitraryResult.firstClip.sourceEnd === 3.7, "Scenario 2: Arbitrary split at 3.7s sets first clip sourceEnd to 3.7");
  assert(arbitraryResult.secondClip.sourceStart === 3.7, "Scenario 2: Arbitrary split at 3.7s sets second clip sourceStart to 3.7");
  assert(arbitraryResult.secondClip.timelineStart === 3.7, "Scenario 2: Arbitrary split at 3.7s sets second clip timelineStart to 3.7");

  // 3. Splitting a clip with nonzero sourceStart
  const clipNonzeroSource = addClip(splitTrackTimeline, {
    id: "clip_nz_source",
    assetId: videoAsset.id,
    trackId: "tr_split_v1",
    sourceStart: 10.0,
    sourceEnd: 30.0,
    timelineStart: 5.0
  });
  // timeline interval is [5.0, 25.0], duration 20s. Split at timeline 12.0s:
  // splitOffset = 12.0 - 5.0 = 7.0; sourceSplit = 10.0 + 7.0 = 17.0
  const nzSourceResult = splitClipWithResult(clipNonzeroSource, "clip_nz_source", 12.0, { assets: [videoAsset] });
  assert(nzSourceResult.firstClip.sourceStart === 10.0 && nzSourceResult.firstClip.sourceEnd === 17.0, "Scenario 3: Nonzero sourceStart segment 1 source is [10.0, 17.0]");
  assert(nzSourceResult.firstClip.timelineStart === 5.0, "Scenario 3: Nonzero sourceStart segment 1 timelineStart is 5.0");
  assert(nzSourceResult.secondClip.sourceStart === 17.0 && nzSourceResult.secondClip.sourceEnd === 30.0, "Scenario 3: Nonzero sourceStart segment 2 source is [17.0, 30.0]");
  assert(nzSourceResult.secondClip.timelineStart === 12.0, "Scenario 3: Nonzero sourceStart segment 2 timelineStart is 12.0");

  // 4. Splitting a clip with nonzero timelineStart
  const clipNonzeroTimeline = addClip(splitTrackTimeline, {
    id: "clip_nz_tl",
    assetId: videoAsset.id,
    trackId: "tr_split_v1",
    sourceStart: 0,
    sourceEnd: 20.0,
    timelineStart: 15.0
  });
  // timeline interval is [15.0, 35.0]. Split at timeline 22.5s:
  // splitOffset = 22.5 - 15.0 = 7.5; sourceSplit = 0 + 7.5 = 7.5
  const nzTlResult = splitClipWithResult(clipNonzeroTimeline, "clip_nz_tl", 22.5, { assets: [videoAsset] });
  assert(nzTlResult.firstClip.timelineStart === 15.0 && nzTlResult.firstClip.sourceEnd === 7.5, "Scenario 4: Nonzero timelineStart segment 1 is [15.0, 22.5]");
  assert(nzTlResult.secondClip.timelineStart === 22.5 && nzTlResult.secondClip.sourceStart === 7.5, "Scenario 4: Nonzero timelineStart segment 2 starts at 22.5s");

  // 5. Preserving assetId and trackId
  assert(midpointResult.firstClip.assetId === videoAsset.id && midpointResult.secondClip.assetId === videoAsset.id, "Scenario 5: Both segments preserve assetId");
  assert(midpointResult.firstClip.trackId === "tr_split_v1" && midpointResult.secondClip.trackId === "tr_split_v1", "Scenario 5: Both segments preserve trackId");

  // 6. Preserving original clip ID for the first segment
  assert(midpointResult.firstClip.id === "clip_midpoint", "Scenario 6: First segment preserves original clip ID exactly");

  // 7. Generating a distinct ID for the second segment
  assert(midpointResult.secondClip.id !== midpointResult.firstClip.id, "Scenario 7: Second segment has distinct ID from first segment");
  assert(typeof midpointResult.secondClip.id === "string" && midpointResult.secondClip.id.length > 0, "Scenario 7: Second segment has valid non-empty ID");

  // 8. Ensuring both segments are adjacent without gap or overlap
  const seg1End = midpointResult.firstClip.timelineStart + (midpointResult.firstClip.sourceEnd - midpointResult.firstClip.sourceStart);
  assert(seg1End === midpointResult.secondClip.timelineStart, "Scenario 8: Segment 1 timeline end matches Segment 2 timeline start exactly (no gap/overlap)");
  const trackClips = midpointResult.timeline.tracks[0].clips;
  assert(trackClips.length === 2, "Scenario 8: Track contains both adjacent clips");
  assert(trackClips[0].id === midpointResult.firstClip.id && trackClips[1].id === midpointResult.secondClip.id, "Scenario 8: Track preserves in-place sequential ordering");

  // 9. Rejecting split at the clip start
  let splitAtStartThrew = false;
  try {
    splitClip(clip1Timeline, "clip_midpoint", 0.0);
  } catch (e: any) {
    splitAtStartThrew = true;
    assert(e.message.includes("strictly greater than clip start"), "Scenario 9: Error mentions split point must be strictly greater than start");
  }
  assert(splitAtStartThrew, "Scenario 9: Rejects split at clip start (splitTimelineTime === timelineStart)");

  // 10. Rejecting split at the clip end
  let splitAtEndThrew = false;
  try {
    splitClip(clip1Timeline, "clip_midpoint", 10.0);
  } catch (e: any) {
    splitAtEndThrew = true;
    assert(e.message.includes("strictly less than clip end"), "Scenario 10: Error mentions split point must be strictly less than end");
  }
  assert(splitAtEndThrew, "Scenario 10: Rejects split at clip end (splitTimelineTime === timelineEnd)");

  // 11. Rejecting split outside the clip
  let splitBeforeThrew = false;
  try {
    splitClip(clipNonzeroTimeline, "clip_nz_tl", 10.0); // starts at 15.0
  } catch {
    splitBeforeThrew = true;
  }
  assert(splitBeforeThrew, "Scenario 11: Rejects split before clip start");

  let splitAfterThrew = false;
  try {
    splitClip(clipNonzeroTimeline, "clip_nz_tl", 40.0); // ends at 35.0
  } catch {
    splitAfterThrew = true;
  }
  assert(splitAfterThrew, "Scenario 11: Rejects split after clip end");

  let splitNaNThrew = false;
  try {
    splitClip(clip1Timeline, "clip_midpoint", NaN);
  } catch {
    splitNaNThrew = true;
  }
  assert(splitNaNThrew, "Scenario 11: Rejects split with NaN");

  // 12. Rejecting nonexistent clip IDs
  let splitNonexistentThrew = false;
  try {
    splitClip(clip1Timeline, "nonexistent_clip", 5.0);
  } catch (e: any) {
    splitNonexistentThrew = true;
    assert(e.message.includes("not found"), "Scenario 12: Error message indicates clip was not found");
  }
  assert(splitNonexistentThrew, "Scenario 12: Rejects nonexistent clip ID");

  // 13. Preserving original timeline immutability
  assert(clip1Timeline.tracks[0].clips.length === 1, "Scenario 13: Original timeline tracks still has only 1 clip");
  assert(clip1Timeline.tracks[0].clips[0].sourceEnd === 10, "Scenario 13: Original clip sourceEnd remained 10s");
  assert(clip1Timeline.tracks[0].clips[0].id === "clip_midpoint", "Scenario 13: Original clip ID unchanged");

  // 14. Validating the resulting timeline
  const validSplitTimeline = splitClip(clip1Timeline, "clip_midpoint", 4.0, { assets: [videoAsset] });
  const validationCheck = validateTimeline(validSplitTimeline, { assets: [videoAsset] });
  assert(validationCheck.valid, "Scenario 14: validateTimeline confirms resulting timeline is 100% valid");
  assert(validationCheck.errors.length === 0, "Scenario 14: Zero validation errors on split timeline");

  // ==========================================
  // [Test 15] Trim Clip Operation (Comprehensive Scenarios)
  // ==========================================
  console.log("\n[Test 15] Trim Clip Operation — Comprehensive Scenarios");

  const trimBaseTl = createEmptyTimeline({ projectId: "trim_proj", id: "tl_trim" });
  const trimTrackTl = addTrack(trimBaseTl, { id: "tr_trim_v1", name: "Video Track", type: "video" });

  const clipInitial = addClip(trimTrackTl, {
    id: "clip_trim_1",
    assetId: videoAsset.id,
    trackId: "tr_trim_v1",
    sourceStart: 0,
    sourceEnd: 20,
    timelineStart: 0,
    name: "Trim Test Clip"
  });

  // 1. Left trim: Moves beginning forward
  const leftTrimmed = trimClip(clipInitial, "clip_trim_1", "left", 5.0, { assets: [videoAsset] });
  const cLeft = leftTrimmed.tracks[0].clips[0];
  assert(cLeft.timelineStart === 5.0, "Left trim sets timelineStart to 5.0s");
  assert(cLeft.sourceStart === 5.0, "Left trim increases sourceStart to 5.0s");
  assert(cLeft.sourceEnd === 20.0, "Left trim preserves sourceEnd at 20.0s");
  assert(cLeft.sourceEnd - cLeft.sourceStart === 15.0, "Left trim duration is 15.0s");
  assert(cLeft.timelineStart + (cLeft.sourceEnd - cLeft.sourceStart) === 20.0, "Left trim preserves clip timeline end at 20.0s");

  // 2. Right trim: Moves end backward
  const rightTrimmed = trimClip(clipInitial, "clip_trim_1", "right", 12.0, { assets: [videoAsset] });
  const cRight = rightTrimmed.tracks[0].clips[0];
  assert(cRight.timelineStart === 0.0, "Right trim preserves timelineStart at 0.0s");
  assert(cRight.sourceStart === 0.0, "Right trim preserves sourceStart at 0.0s");
  assert(cRight.sourceEnd === 12.0, "Right trim sets sourceEnd to 12.0s");
  assert(cRight.sourceEnd - cRight.sourceStart === 12.0, "Right trim duration is 12.0s");
  assert(cRight.timelineStart + (cRight.sourceEnd - cRight.sourceStart) === 12.0, "Right trim sets timeline end to 12.0s");

  // 3. Nonzero sourceStart & nonzero timelineStart (left trim)
  const clipOffset = addClip(trimTrackTl, {
    id: "clip_offset",
    assetId: videoAsset.id,
    trackId: "tr_trim_v1",
    sourceStart: 10.0,
    sourceEnd: 30.0,
    timelineStart: 5.0
  }); // interval [5.0, 25.0], duration 20s
  // Trim left edge forward from 5.0s to 8.0s (offset +3s)
  const offsetLeftTrim = trimClip(clipOffset, "clip_offset", "left", 8.0, { assets: [videoAsset] });
  const cOffsetLeft = offsetLeftTrim.tracks[0].clips[0];
  assert(cOffsetLeft.timelineStart === 8.0, "Nonzero start left trim sets timelineStart to 8.0s");
  assert(cOffsetLeft.sourceStart === 13.0, "Nonzero start left trim offsets sourceStart to 13.0s (10 + 3)");
  assert(cOffsetLeft.sourceEnd === 30.0, "Nonzero start left trim preserves sourceEnd at 30.0s");
  assert(cOffsetLeft.sourceEnd - cOffsetLeft.sourceStart === 17.0, "Nonzero start left trim duration is 17.0s");

  // 4. Nonzero sourceStart & nonzero timelineStart (right trim)
  // Trim right edge from 25.0s down to 20.0s (duration 20 - 5 = 15s)
  const offsetRightTrim = trimClip(clipOffset, "clip_offset", "right", 20.0, { assets: [videoAsset] });
  const cOffsetRight = offsetRightTrim.tracks[0].clips[0];
  assert(cOffsetRight.timelineStart === 5.0, "Nonzero start right trim preserves timelineStart at 5.0s");
  assert(cOffsetRight.sourceStart === 10.0, "Nonzero start right trim preserves sourceStart at 10.0s");
  assert(cOffsetRight.sourceEnd === 25.0, "Nonzero start right trim sets sourceEnd to 25.0s (10 + 15)");
  assert(cOffsetRight.sourceEnd - cOffsetRight.sourceStart === 15.0, "Nonzero start right trim duration is 15.0s");

  // 5. Preserving clip ID, assetId, trackId, and metadata
  assert(cLeft.id === "clip_trim_1", "Trim preserves original clip ID");
  assert(cLeft.assetId === videoAsset.id, "Trim preserves original assetId");
  assert(cLeft.trackId === "tr_trim_v1", "Trim preserves original trackId");
  assert(cLeft.name === "Trim Test Clip", "Trim preserves original clip name");

  // 6. Original timeline immutability
  assert(clipInitial.tracks[0].clips[0].timelineStart === 0, "Original clip timelineStart remained 0");
  assert(clipInitial.tracks[0].clips[0].sourceStart === 0, "Original clip sourceStart remained 0");
  assert(clipInitial.tracks[0].clips[0].sourceEnd === 20, "Original clip sourceEnd remained 20");

  // 7. Rejecting invalid boundaries
  let leftBeyondRightThrew = false;
  try {
    trimClip(clipInitial, "clip_trim_1", "left", 20.0); // right edge is 20.0
  } catch (e: any) {
    leftBeyondRightThrew = true;
    assert(e.message.includes("cannot be at or beyond right edge"), "Error mentions left trim cannot be at/beyond right edge");
  }
  assert(leftBeyondRightThrew, "Rejects left trim at or beyond right edge");

  let rightBeforeLeftThrew = false;
  try {
    trimClip(clipInitial, "clip_trim_1", "right", 0.0); // left edge is 0.0
  } catch (e: any) {
    rightBeforeLeftThrew = true;
    assert(e.message.includes("cannot be at or before left edge"), "Error mentions right trim cannot be at/before left edge");
  }
  assert(rightBeforeLeftThrew, "Rejects right trim at or before left edge");

  let leftNegativeTimelineThrew = false;
  try {
    trimClip(clipInitial, "clip_trim_1", "left", -1.0);
  } catch {
    leftNegativeTimelineThrew = true;
  }
  assert(leftNegativeTimelineThrew, "Rejects left trim to negative timeline position");

  let leftExceedSourceOriginThrew = false;
  try {
    // clipOffset sourceStart is 10.0, timelineStart is 5.0. Moving timelineStart to 0.0 tries to extend head by 5s (sourceStart 5.0) which is valid,
    // but moving timelineStart to -6s or if timelineStart was 20 and sourceStart 5, extending by 10s would make sourceStart -5s:
    const clipNearOrigin = addClip(trimTrackTl, {
      id: "clip_near_origin",
      assetId: videoAsset.id,
      trackId: "tr_trim_v1",
      sourceStart: 2.0,
      sourceEnd: 15.0,
      timelineStart: 10.0
    });
    // Extending left edge from 10.0s to 5.0s would offset by -5s, so sourceStart would be 2.0 - 5.0 = -3.0s:
    trimClip(clipNearOrigin, "clip_near_origin", "left", 5.0);
  } catch (e: any) {
    leftExceedSourceOriginThrew = true;
    assert(e.message.includes("exceeds media source origin"), "Error mentions exceeding source origin");
  }
  assert(leftExceedSourceOriginThrew, "Rejects left trim extending earlier than source origin 0.0s");

  // 8. Rejecting zero and negative duration
  let rightZeroDurationThrew = false;
  try {
    trimClip(clipOffset, "clip_offset", "right", 5.0); // right edge equal to left edge
  } catch {
    rightZeroDurationThrew = true;
  }
  assert(rightZeroDurationThrew, "Rejects right trim producing zero duration");

  // 9. Rejecting non-finite time values
  let nanTrimThrew = false;
  try {
    trimClip(clipInitial, "clip_trim_1", "right", NaN);
  } catch {
    nanTrimThrew = true;
  }
  assert(nanTrimThrew, "Rejects trim with NaN");

  // 10. Rejecting missing clip
  let missingClipThrew = false;
  try {
    trimClip(clipInitial, "ghost_clip", "left", 5.0);
  } catch (e: any) {
    missingClipThrew = true;
    assert(e.message.includes("not found"), "Error mentions clip not found");
  }
  assert(missingClipThrew, "Rejects missing clip ID");

  // 11. Rejecting invalid edge parameter
  let invalidEdgeThrew = false;
  try {
    trimClip(clipInitial, "clip_trim_1", "top" as any, 5.0);
  } catch {
    invalidEdgeThrew = true;
  }
  assert(invalidEdgeThrew, "Rejects invalid edge parameter");

  // 12. Resulting timeline validation
  const validationOfTrim = validateTimeline(leftTrimmed, { assets: [videoAsset] });
  assert(validationOfTrim.valid, "Resulting trimmed timeline passes validateTimeline");

  // ==========================================
  // [Test 16] Delete Clip Operation (deleteClip)
  // ==========================================
  console.log("\n[Test 16] Delete Clip Operation (deleteClip)");

  const delBaseTl = createEmptyTimeline({
    projectId: "del_proj_1",
    id: "tl_del_1",
    settings: { frameRate: 60, width: 3840, height: 2160 }
  });
  const delTrackV1 = addTrack(delBaseTl, { id: "tr_del_v1", name: "Video Track 1", type: "video" });
  const delTrackV2 = addTrack(delTrackV1, { id: "tr_del_v2", name: "Video Track 2", type: "video" });

  const delClip1 = addClip(delTrackV2, {
    id: "c_del_1",
    assetId: videoAsset.id,
    trackId: "tr_del_v1",
    sourceStart: 0,
    sourceEnd: 10,
    timelineStart: 0,
    name: "Clip 1"
  });
  const delClip2 = addClip(delClip1, {
    id: "c_del_2",
    assetId: videoAsset.id,
    trackId: "tr_del_v1",
    sourceStart: 10,
    sourceEnd: 20,
    timelineStart: 10,
    name: "Clip 2"
  });
  const delClip3OnTrack2 = addClip(delClip2, {
    id: "c_del_track2",
    assetId: videoAsset.id,
    trackId: "tr_del_v2",
    sourceStart: 0,
    sourceEnd: 15,
    timelineStart: 0,
    name: "Clip on Track 2"
  });

  // 1. Deleting from a track containing multiple clips
  const afterDel1 = deleteClip(delClip3OnTrack2, "c_del_1", { assets: [videoAsset] });
  assert(afterDel1.tracks[0].clips.length === 1, "Track 1 now has 1 clip remaining");
  assert(afterDel1.tracks[0].clips[0].id === "c_del_2", "Remaining clip on Track 1 is c_del_2");
  assert(afterDel1.tracks[0].clips[0].name === "Clip 2", "Preserves remaining clip metadata");
  assert(afterDel1.tracks[0].clips[0].sourceStart === 10 && afterDel1.tracks[0].clips[0].sourceEnd === 20, "Preserves remaining clip source range");

  // 2. Deleting from one track without affecting other tracks
  assert(afterDel1.tracks[1].clips.length === 1, "Track 2 clips count unaffected");
  assert(afterDel1.tracks[1].clips[0].id === "c_del_track2", "Track 2 clip unchanged");

  // 3. Deleting the only clip on a track (empty track result)
  const afterDelTrack2Clip = deleteClip(afterDel1, "c_del_track2", { assets: [videoAsset] });
  assert(afterDelTrack2Clip.tracks[1].clips.length === 0, "Track 2 is now empty");
  assert(afterDelTrack2Clip.tracks[0].clips.length === 1, "Track 1 still has its clip");

  // 4. Preserving timeline settings and metadata
  assert(afterDel1.settings.frameRate === 60, "Settings frameRate preserved (60 fps)");
  assert(afterDel1.settings.width === 3840 && afterDel1.settings.height === 2160, "Settings resolution preserved");
  assert(afterDel1.id === "tl_del_1", "Timeline ID preserved");
  assert(afterDel1.projectId === "del_proj_1", "Project ID preserved");

  // 5. Rejecting nonexistent clip IDs
  let delNonexistentThrew = false;
  try {
    deleteClip(afterDel1, "ghost_clip_id");
  } catch (e: any) {
    delNonexistentThrew = true;
    assert(e.message.includes("Cannot delete clip: clip 'ghost_clip_id' was not found in timeline."), "Clear error message on missing clip ID");
  }
  assert(delNonexistentThrew, "Rejects nonexistent clip ID");

  // 6. Original timeline immutability
  assert(delClip3OnTrack2.tracks[0].clips.length === 2, "Original timeline Track 1 still has 2 clips");
  assert(delClip3OnTrack2.tracks[1].clips.length === 1, "Original timeline Track 2 still has 1 clip");

  // 7. Resulting timeline validation
  const validationOfDel = validateTimeline(afterDelTrack2Clip, { assets: [videoAsset] });
  assert(validationOfDel.valid, "Resulting timeline after deletions passes validateTimeline");
  assert(validationOfDel.errors.length === 0, "Zero validation errors on deleted timeline");

  // ==========================================
  // Test 17: Timeline History (Undo/Redo Stack)
  // ==========================================
  console.log("\n[Test 17] Timeline History (Undo/Redo Stack)");

  const tlBase = createEmptyTimeline({
    projectId: "proj_hist_1",
    id: "tl_hist_1",
    settings: { frameRate: 30, width: 1920, height: 1080 }
  });
  const tlWithTrack = addTrack(tlBase, {
    id: "track_v1",
    name: "Video 1",
    type: "video"
  });
  const baseTl = addClip(tlWithTrack, {
    id: "clip_hist_1",
    assetId: "asset_video_1",
    trackId: "track_v1",
    sourceStart: 0,
    sourceEnd: 30,
    timelineStart: 0,
    name: "Base Clip"
  });

  const history = new TimelineHistory({ maxHistory: 5, initialTimeline: baseTl });

  // 1. Initial State
  assert(!history.canUndo(), "Initial history has canUndo: false");
  assert(!history.canRedo(), "Initial history has canRedo: false");
  assert(history.getUndoCount() === 0, "Initial getUndoCount is 0");
  assert(history.getRedoCount() === 0, "Initial getRedoCount is 0");
  assert(history.getHistoryLength() === 1, "Initial history length is 1");
  assert(history.getCurrent()?.tracks[0].clips[0].id === "clip_hist_1", "getCurrent returns baseline timeline");

  // 2. Immutability of returned timeline
  const currentSnapshot = history.getCurrent()!;
  currentSnapshot.tracks[0].clips[0].timelineStart = 999;
  assert(history.getCurrent()?.tracks[0].clips[0].timelineStart === 0, "Mutating returned timeline does not corrupt history snapshot");

  // 3. Move edit push
  const movedTl = moveClip(baseTl, "clip_hist_1", 15, undefined, { assets: [videoAsset] });
  const pushResult1 = history.push(movedTl);
  assert(pushResult1 === true, "Push moved timeline succeeds");
  assert(history.canUndo(), "canUndo is true after move");
  assert(!history.canRedo(), "canRedo is false at latest state");
  assert(history.getUndoCount() === 1, "getUndoCount is 1 after move");
  assert(history.getCurrent()?.tracks[0].clips[0].timelineStart === 15, "getCurrent reflects moved position");

  // 4. Duplicate state suppression
  const pushedDuplicate = history.push(movedTl);
  assert(pushedDuplicate === false, "Duplicate timeline push is suppressed");
  assert(history.getUndoCount() === 1, "Undo count unchanged after duplicate push");

  // 5. Trim edit push
  const trimmedTl = trimClip(movedTl, "clip_hist_1", "right", 35, { assets: [videoAsset] });
  history.push(trimmedTl);
  assert(history.getUndoCount() === 2, "Undo count is 2 after trim");
  assert(history.getCurrent()?.tracks[0].clips[0].sourceEnd === 20, "getCurrent reflects trimmed sourceEnd");

  // 6. Split edit push
  const splitTl = splitClip(trimmedTl, "clip_hist_1", 25, { assets: [videoAsset] });
  history.push(splitTl);
  assert(history.getUndoCount() === 3, "Undo count is 3 after split");
  assert(history.getCurrent()?.tracks[0].clips.length === 2, "getCurrent reflects 2 clips after split");

  // 7. Delete edit push
  const secondClipId = splitTl.tracks[0].clips[1].id;
  const deletedTl = deleteClip(splitTl, secondClipId, { assets: [videoAsset] });
  history.push(deletedTl);
  assert(history.getUndoCount() === 4, "Undo count is 4 after delete");
  assert(history.getCurrent()?.tracks[0].clips.length === 1, "getCurrent reflects 1 clip after delete");

  // 8. Undo step-by-step
  // Undo Delete -> restores 2 clips (split state)
  const undoneDelete = history.undo();
  assert(undoneDelete !== null, "undo() returns state");
  assert(undoneDelete?.tracks[0].clips.length === 2, "Undo delete restores 2 clips");
  assert(undoneDelete?.tracks[0].clips.some(c => c.id === secondClipId), "Undo delete restores the exact deleted clip ID");
  assert(history.canUndo() && history.canRedo(), "canUndo and canRedo both true in mid-stack");
  assert(history.getUndoCount() === 3 && history.getRedoCount() === 1, "Undo/Redo counts correct after 1st undo");

  // Undo Split -> restores 1 single clip (pre-split trimmed state)
  const undoneSplit = history.undo();
  assert(undoneSplit?.tracks[0].clips.length === 1, "Undo split restores single clip");
  assert(undoneSplit?.tracks[0].clips[0].id === "clip_hist_1", "Undo split restores original clip ID");
  assert(undoneSplit?.tracks[0].clips[0].timelineStart === 15, "Pre-split start is 15");
  assert(undoneSplit?.tracks[0].clips[0].sourceEnd === 20, "Pre-split sourceEnd is 20");

  // Undo Trim -> restores pre-trimmed moved state
  const undoneTrim = history.undo();
  assert(undoneTrim?.tracks[0].clips[0].sourceEnd === 30, "Undo trim restores pre-trim sourceEnd (30)");
  assert(undoneTrim?.tracks[0].clips[0].timelineStart === 15, "Pre-trim timelineStart preserved (15)");

  // Undo Move -> restores initial base state
  const undoneMove = history.undo();
  assert(undoneMove?.tracks[0].clips[0].timelineStart === 0, "Undo move restores original timelineStart (0)");
  assert(!history.canUndo(), "canUndo is false at bottom of stack");
  assert(history.undo() === null, "undo() at bottom of stack returns null");

  // 9. Redo step-by-step
  const redoneMove = history.redo();
  assert(redoneMove?.tracks[0].clips[0].timelineStart === 15, "Redo move restores timelineStart 15");
  const redoneTrim = history.redo();
  assert(redoneTrim?.tracks[0].clips[0].sourceEnd === 20, "Redo trim restores trimmed sourceEnd 20");
  const redoneSplit = history.redo();
  assert(redoneSplit?.tracks[0].clips.length === 2, "Redo split restores 2 clips");
  const redoneDelete = history.redo();
  assert(redoneDelete?.tracks[0].clips.length === 1, "Redo delete re-applies deletion");
  assert(!history.canRedo(), "canRedo is false at top of stack");
  assert(history.redo() === null, "redo() at top of stack returns null");

  // 10. Redo branch invalidation
  // Step back 2 times to split state
  history.undo(); // back to split
  history.undo(); // back to trim
  assert(history.canRedo(), "canRedo is true before branch invalidation");
  // Now make a different edit: move the trimmed clip to timelineStart: 50
  const branchTl = moveClip(history.getCurrent()!, "clip_hist_1", 50, undefined, { assets: [videoAsset] });
  history.push(branchTl);
  assert(!history.canRedo(), "Redo branch is invalidated after new edit");
  assert(history.getRedoCount() === 0, "Redo count is 0 after new edit");
  assert(history.getCurrent()?.tracks[0].clips[0].timelineStart === 50, "Current state is the new branch");

  // 11. History Limit (Max History sliding window)
  const smallHistory = new TimelineHistory({ maxHistory: 3, initialTimeline: baseTl });
  assert(smallHistory.getHistoryLength() === 1, "smallHistory starts at 1");
  const edit1 = moveClip(baseTl, "clip_hist_1", 10, undefined, { assets: [videoAsset] });
  const edit2 = moveClip(edit1, "clip_hist_1", 20, undefined, { assets: [videoAsset] });
  const edit3 = moveClip(edit2, "clip_hist_1", 30, undefined, { assets: [videoAsset] });
  smallHistory.push(edit1);
  smallHistory.push(edit2);
  smallHistory.push(edit3); // 4th total state pushed with maxHistory: 3
  assert(smallHistory.getHistoryLength() === 3, "History length capped at maxHistory (3)");
  // Oldest state (timelineStart 0) was dropped by sliding window; undoing twice should reach edit1 (timelineStart 10)
  smallHistory.undo(); // back to edit2 (20)
  const oldestAvailable = smallHistory.undo(); // back to edit1 (10)
  assert(oldestAvailable?.tracks[0].clips[0].timelineStart === 10, "Oldest available state is edit1 (sliding window)");
  assert(!smallHistory.canUndo(), "Cannot undo beyond maxHistory sliding window limit");

  // 12. Reconcile on Persistence Failure
  const reconHistory = new TimelineHistory({ maxHistory: 10, initialTimeline: baseTl });
  const reconEdit1 = moveClip(baseTl, "clip_hist_1", 10, undefined, { assets: [videoAsset] });
  const reconEdit2 = moveClip(reconEdit1, "clip_hist_1", 20, undefined, { assets: [videoAsset] });
  reconHistory.push(reconEdit1);
  reconHistory.push(reconEdit2);
  assert(reconHistory.getCurrentIndex() === 2, "Current index is 2 before failure");

  // Simulate server reject rollback to reconEdit1
  reconHistory.reconcile(reconEdit1);
  assert(reconHistory.getCurrentIndex() === 1, "Reconcile sets history index back to confirmed server state index");
  assert(reconHistory.getCurrent()?.tracks[0].clips[0].timelineStart === 10, "Current timeline matches reconciled state");
  assert(!reconHistory.canRedo(), "Reconcile truncates unconfirmed forward edits and leaves no invalid redo branch");
  assert(reconHistory.canUndo(), "Reconcile preserves valid confirmed prior history");

  // Reconcile with unrecorded server state re-initializes stack safely
  reconHistory.reconcile(baseTl);
  assert(reconHistory.getCurrent()?.tracks[0].clips[0].timelineStart === 0, "Reconcile with baseline resets to baseline");
  assert(reconHistory.getCurrentIndex() === 0, "Reconcile resets index to 0");

  // ==========================================
  // Test 18: Timeline-to-Source Time Mapping and Playback Synchronization Logic
  // ==========================================
  console.log("\n[Test 18] Timeline-to-Source Time Mapping and Playback Synchronization Logic");

  // 1. A clip beginning at timeline time zero
  const clipAtZero = {
    id: "clip_zero",
    assetId: "asset_video_1",
    trackId: "track_v1",
    sourceStart: 0,
    sourceEnd: 15,
    timelineStart: 0,
    name: "Clip at 0"
  };
  assert(timelineTimeToSourceTime(clipAtZero, 0) === 0, "1. Timeline 0 maps to source 0");
  assert(timelineTimeToSourceTime(clipAtZero, 7.5) === 7.5, "1. Timeline 7.5 maps to source 7.5");
  assert(timelineTimeToSourceTime(clipAtZero, 15) === 15, "1. Timeline 15 maps to source 15 (clip end)");
  assert(sourceTimeToTimelineTime(clipAtZero, 0) === 0, "1. Inverse: Source 0 maps to timeline 0");
  assert(sourceTimeToTimelineTime(clipAtZero, 7.5) === 7.5, "1. Inverse: Source 7.5 maps to timeline 7.5");

  // 2. A clip beginning at a non-zero timeline position
  const pbClipNonzeroTimeline = {
    id: "clip_offset_tl",
    assetId: "asset_video_1",
    trackId: "track_v1",
    sourceStart: 0,
    sourceEnd: 20,
    timelineStart: 12.0,
    name: "Clip starting at 12s"
  };
  assert(timelineTimeToSourceTime(pbClipNonzeroTimeline, 12.0) === 0, "2. Timeline start 12.0 maps to source 0");
  assert(timelineTimeToSourceTime(pbClipNonzeroTimeline, 17.5) === 5.5, "2. Timeline 17.5 maps to source 5.5 (17.5 - 12.0)");
  assert(sourceTimeToTimelineTime(pbClipNonzeroTimeline, 5.5) === 17.5, "2. Inverse: Source 5.5 maps to timeline 17.5");

  // 3. A clip with a non-zero sourceStart
  const pbClipNonzeroSource = {
    id: "clip_offset_src",
    assetId: "asset_video_1",
    trackId: "track_v1",
    sourceStart: 25.0,
    sourceEnd: 45.0,
    timelineStart: 8.0,
    name: "Clip starting at source 25s"
  };
  assert(timelineTimeToSourceTime(pbClipNonzeroSource, 8.0) === 25.0, "3. Timeline 8.0 maps to sourceStart 25.0");
  assert(timelineTimeToSourceTime(pbClipNonzeroSource, 18.0) === 35.0, "3. Timeline 18.0 maps to source 35.0 (25 + 10)");
  assert(timelineTimeToSourceTime(pbClipNonzeroSource, 28.0) === 45.0, "3. Timeline 28.0 maps to sourceEnd 45.0");
  assert(sourceTimeToTimelineTime(pbClipNonzeroSource, 35.0) === 18.0, "3. Inverse: Source 35.0 maps to timeline 18.0");

  // 4. A moved clip
  const clipMoved = moveClip(
    addClip(tlWithTrack, clipAtZero),
    "clip_zero",
    30.0,
    undefined,
    { assets: [videoAsset] }
  ).tracks[0].clips[0];
  assert(clipMoved.timelineStart === 30.0, "4. Moved clip starts at 30.0s");
  assert(timelineTimeToSourceTime(clipMoved, 30.0) === 0, "4. Moved clip start (30.0s) maps to sourceStart (0s)");
  assert(timelineTimeToSourceTime(clipMoved, 35.0) === 5.0, "4. Moved clip at 35.0s maps to source 5.0s");

  // 5. A split clip and both resulting segments
  const tlToSplit = addClip(tlWithTrack, {
    id: "clip_to_split",
    assetId: "asset_video_1",
    trackId: "track_v1",
    sourceStart: 0,
    sourceEnd: 30,
    timelineStart: 10,
    name: "Clip to split"
  });
  const splitResult = splitClipWithResult(tlToSplit, "clip_to_split", 22.0, { assets: [videoAsset] });
  const seg1 = splitResult.firstClip;
  const seg2 = splitResult.secondClip;

  assert(seg1.timelineStart === 10 && seg1.sourceStart === 0 && seg1.sourceEnd === 12, "5. Segment 1 source is [0, 12]");
  assert(timelineTimeToSourceTime(seg1, 10.0) === 0, "5. Segment 1 start (10s) maps to source 0");
  assert(timelineTimeToSourceTime(seg1, 16.0) === 6.0, "5. Segment 1 midpoint (16s) maps to source 6.0");
  assert(timelineTimeToSourceTime(seg1, 22.0) === 12.0, "5. Segment 1 boundary (22s) maps to source 12.0");

  assert(seg2.timelineStart === 22.0 && seg2.sourceStart === 12.0 && seg2.sourceEnd === 30.0, "5. Segment 2 source is [12, 30]");
  assert(timelineTimeToSourceTime(seg2, 22.0) === 12.0, "5. Segment 2 start (22s) maps to sourceStart 12.0");
  assert(timelineTimeToSourceTime(seg2, 27.0) === 17.0, "5. Segment 2 time (27s) maps to source 17.0");

  // 6. A left-trimmed clip
  const trimmedLeft = trimClip(
    addClip(tlWithTrack, clipAtZero),
    "clip_zero",
    "left",
    5.0,
    { assets: [videoAsset] }
  ).tracks[0].clips[0];
  assert(trimmedLeft.timelineStart === 5.0 && trimmedLeft.sourceStart === 5.0, "6. Left trim sets start to 5.0s");
  assert(timelineTimeToSourceTime(trimmedLeft, 5.0) === 5.0, "6. Left-trimmed clip start maps to sourceStart 5.0");
  assert(timelineTimeToSourceTime(trimmedLeft, 10.0) === 10.0, "6. Left-trimmed clip at 10.0 maps to source 10.0");

  // 7. A right-trimmed clip
  const trimmedRight = trimClip(
    addClip(tlWithTrack, clipAtZero),
    "clip_zero",
    "right",
    8.0,
    { assets: [videoAsset] }
  ).tracks[0].clips[0];
  assert(trimmedRight.timelineStart === 0 && trimmedRight.sourceEnd === 8.0, "7. Right trim sets sourceEnd to 8.0s");
  assert(timelineTimeToSourceTime(trimmedRight, 8.0) === 8.0, "7. Right-trimmed clip at end maps to sourceEnd 8.0");

  // 8. Seeking into a gap
  const tlWithGap = addClip(
    addClip(tlWithTrack, {
      id: "clip_gap_1",
      assetId: "asset_video_1",
      trackId: "track_v1",
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      name: "Gap Clip 1"
    }),
    {
      id: "clip_gap_2",
      assetId: "asset_video_1",
      trackId: "track_v1",
      sourceStart: 10,
      sourceEnd: 20,
      timelineStart: 20, // 10s to 20s is an empty gap!
      name: "Gap Clip 2"
    }
  );

  const snapAtGap = getTimelinePlaybackSnapshot(tlWithGap, 15.0);
  assert(snapAtGap.isGap === true, "8. Snapshot at 15.0s detects gap");
  assert(snapAtGap.activeClip === null, "8. Snapshot at 15.0s has null active clip");
  assert(findActiveVideoClipAtTime(tlWithGap, 15.0) === null, "8. findActiveVideoClipAtTime returns null in gap");

  // 9. Seeking exactly to clip boundaries
  const snapAtStartBoundary = getTimelinePlaybackSnapshot(tlWithGap, 0);
  assert(snapAtStartBoundary.activeClip !== null && snapAtStartBoundary.activeClip.clip.id === "clip_gap_1", "9. At start boundary 0s, clip 1 is active");
  assert(snapAtStartBoundary.activeClip.sourceTime === 0, "9. Source time at 0s is 0");

  const snapAtEndBoundary = getTimelinePlaybackSnapshot(tlWithGap, 10.0);
  assert(snapAtEndBoundary.isGap === true, "9. At exact clip end boundary 10.0s (start of gap), isGap is true");

  const snapAtNextStart = getTimelinePlaybackSnapshot(tlWithGap, 20.0);
  assert(snapAtNextStart.activeClip !== null && snapAtNextStart.activeClip.clip.id === "clip_gap_2", "9. At 20.0s, clip 2 is active");
  assert(snapAtNextStart.activeClip.sourceTime === 10.0, "9. Source time at 20.0s is clip 2 sourceStart (10.0)");

  // 10. Transition to a contiguous next clip
  const snapSplitTransition = getTimelinePlaybackSnapshot(splitResult.timeline, 21.999);
  assert(snapSplitTransition.activeClip?.clip.id === seg1.id, "10. At 21.999s, segment 1 is active");
  assert(snapSplitTransition.nextClip !== null, "10. Next clip is identified");
  assert(snapSplitTransition.nextClip?.clip.id === seg2.id, "10. Next clip is segment 2");
  assert(snapSplitTransition.nextClip?.isContiguous === true, "10. Transition to segment 2 is marked contiguous");
  assert(snapSplitTransition.nextClip?.sourceStart === 12.0, "10. Next clip sourceStart is 12.0");

  // 11. Pausing at a gap or clip end
  const snapClip1End = getTimelinePlaybackSnapshot(tlWithGap, 9.999);
  assert(snapClip1End.nextClip?.isContiguous === false, "11. Next clip across gap (at 20s) is NOT contiguous");
  assert(snapClip1End.nextClip?.gapDuration === 10.0, "11. Gap duration of 10s detected; playback must pause at clip 1 end");

  // 12. Ensuring playback does not create timeline saves or undo/redo entries
  const histPlayback = new TimelineHistory({ initialTimeline: tlWithGap });
  // Simulating playhead movements
  for (let t = 0; t <= 10; t += 0.5) {
    const snap = getTimelinePlaybackSnapshot(tlWithGap, t);
    assert(snap !== null, "Playback snapshot calculated cleanly");
  }
  assert(histPlayback.getHistoryLength() === 1, "12. History length remains 1 during playback scrubbing");
  assert(!histPlayback.canUndo(), "12. canUndo remains false during playback scrubbing");
  assert(!histPlayback.canRedo(), "12. canRedo remains false during playback scrubbing");

  // ==========================================
  // [Test 19] Track Management Operations & Validation
  // ==========================================
  console.log("\n[Test 19] Track Management Operations & Validation");

  // 1. Adding each supported track type
  let tmTl = createEmptyTimeline({ projectId: "tm_proj" });
  assert(tmTl.tracks.length === 0, "Initial timeline has 0 tracks");

  tmTl = addTrack(tmTl, { id: "tr_vid_1", name: "Video 1", type: "video" });
  assert(tmTl.tracks.length === 1 && tmTl.tracks[0].type === "video", "Added video track successfully");
  assert(tmTl.tracks[0].index === 0, "Video track index is 0");

  tmTl = addTrack(tmTl, { id: "tr_aud_1", name: "Audio 1", type: "audio" });
  assert(tmTl.tracks.length === 2 && tmTl.tracks[1].type === "audio", "Added audio track successfully");
  assert(tmTl.tracks[1].index === 1, "Audio track index is 1");

  tmTl = addTrack(tmTl, { id: "tr_cap_1", name: "Captions 1", type: "caption" });
  assert(tmTl.tracks.length === 3 && tmTl.tracks[2].type === "caption", "Added caption track successfully");
  assert(tmTl.tracks[2].index === 2, "Caption track index is 2");

  // 2. Default track name generation
  assert(generateDefaultTrackName(tmTl, "video") === "Video 2", "Default video track name is 'Video 2'");
  assert(generateDefaultTrackName(tmTl, "audio") === "Audio 2", "Default audio track name is 'Audio 2'");
  assert(generateDefaultTrackName(tmTl, "caption") === "Captions 2", "Default caption track name is 'Captions 2'");

  // 3. Rejecting blank or whitespace-only names
  let blankAddThrew = false;
  try {
    addTrack(tmTl, { name: "   ", type: "video" });
  } catch (e: any) {
    blankAddThrew = true;
    assert(e.message.includes("track name must be a non-empty string"), "Rejects whitespace-only track name on add");
  }
  assert(blankAddThrew, "addTrack throws on whitespace-only name");

  let blankRenameThrew = false;
  try {
    renameTrack(tmTl, "tr_vid_1", "   \t  ");
  } catch (e: any) {
    blankRenameThrew = true;
    assert(e.message.includes("new name must be a non-empty string"), "Rejects whitespace-only track name on rename");
  }
  assert(blankRenameThrew, "renameTrack throws on whitespace-only name");

  // 4. Renaming a track
  const renamedTl = renameTrack(tmTl, "tr_vid_1", "  Main B-Roll  ");
  assert(renamedTl.tracks[0].name === "Main B-Roll", "Track renamed with whitespace trimmed");
  assert(renamedTl.tracks[0].id === "tr_vid_1", "Preserved track ID on rename");
  assert(renamedTl.tracks[0].type === "video", "Preserved track type on rename");
  assert(renamedTl.tracks[0].index === 0, "Preserved track index on rename");
  assert(tmTl.tracks[0].name === "Video 1", "Original timeline was not mutated on rename (immutability)");

  // 5. Nonexistent track rename throws
  let nonExistentRenameThrew = false;
  try {
    renameTrack(tmTl, "tr_does_not_exist", "Valid Name");
  } catch (e: any) {
    nonExistentRenameThrew = true;
  }
  assert(nonExistentRenameThrew, "renameTrack throws on nonexistent track ID");

  // 6. Moving a track down (Video at 0 moved down to 1)
  const movedDownTl = reorderTrack(tmTl, "tr_vid_1", "down");
  assert(movedDownTl.tracks[0].id === "tr_aud_1", "Audio 1 is now at index 0");
  assert(movedDownTl.tracks[0].index === 0, "Audio 1 index recalculated to 0");
  assert(movedDownTl.tracks[1].id === "tr_vid_1", "Video 1 is now at index 1");
  assert(movedDownTl.tracks[1].index === 1, "Video 1 index recalculated to 1");
  assert(movedDownTl.tracks[2].id === "tr_cap_1", "Captions 1 remains at index 2");
  assert(movedDownTl.tracks[2].index === 2, "Captions 1 index remains 2");
  assert(tmTl.tracks[0].id === "tr_vid_1", "Original timeline tracks order was not mutated");

  // 7. Moving a track up (Captions at 2 moved up to 1)
  const movedUpTl = reorderTrack(tmTl, "tr_cap_1", "up");
  assert(movedUpTl.tracks[0].id === "tr_vid_1" && movedUpTl.tracks[0].index === 0, "Video 1 remains at index 0");
  assert(movedUpTl.tracks[1].id === "tr_cap_1" && movedUpTl.tracks[1].index === 1, "Captions 1 is now at index 1");
  assert(movedUpTl.tracks[2].id === "tr_aud_1" && movedUpTl.tracks[2].index === 2, "Audio 1 is now at index 2");

  // 8. Boundary move checks (cannot move top up, cannot move bottom down)
  let topUpThrew = false;
  try {
    reorderTrack(tmTl, "tr_vid_1", "up");
  } catch (e: any) {
    topUpThrew = true;
    assert(e.message.includes("already at the topmost position"), "Cannot move top track up");
  }
  assert(topUpThrew, "reorderTrack throws when moving topmost track up");

  let bottomDownThrew = false;
  try {
    reorderTrack(tmTl, "tr_cap_1", "down");
  } catch (e: any) {
    bottomDownThrew = true;
    assert(e.message.includes("already at the bottommost position"), "Cannot move bottom track down");
  }
  assert(bottomDownThrew, "reorderTrack throws when moving bottommost track down");

  // 9. Preserving clips and references across reordering
  const tlWithClip = addClip(tmTl, {
    id: "c_vid_clip",
    assetId: videoAsset.id,
    trackId: "tr_vid_1",
    sourceStart: 0,
    sourceEnd: 10,
    timelineStart: 0
  }, { assets: [videoAsset] });

  const reorderedWithClip = reorderTrack(tlWithClip, "tr_vid_1", "down");
  const movedTrackWithClip = reorderedWithClip.tracks.find((t) => t.id === "tr_vid_1")!;
  assert(movedTrackWithClip.clips.length === 1, "Clip preserved in moved track");
  assert(movedTrackWithClip.clips[0].id === "c_vid_clip", "Clip ID preserved in moved track");
  assert(movedTrackWithClip.clips[0].trackId === "tr_vid_1", "Clip trackId reference preserved");
  assert(validateTimeline(reorderedWithClip, { assets: [videoAsset] }).valid, "Reordered timeline with clips validates cleanly");

  // 10. Deleting empty track
  assert(tmTl.tracks.some((t) => t.id === "tr_cap_1"), "Timeline has captions track before delete");
  const deletedTrackTl = deleteTrack(tmTl, "tr_cap_1");
  assert(deletedTrackTl.tracks.length === 2, "Captions track removed");
  assert(!deletedTrackTl.tracks.some((t) => t.id === "tr_cap_1"), "Captions track not present in deleted timeline");
  assert(deletedTrackTl.tracks[0].index === 0 && deletedTrackTl.tracks[1].index === 1, "Remaining tracks indices normalized sequentially");
  assert(tmTl.tracks.length === 3, "Original timeline tracks array not mutated (immutability)");

  // 11. Preventing deletion of track containing clips
  let deleteNonEmptyThrew = false;
  try {
    deleteTrack(tlWithClip, "tr_vid_1");
  } catch (e: any) {
    deleteNonEmptyThrew = true;
    assert(e.message.includes("contains 1 clip(s)"), "Informative error specifies track contains clips");
  }
  assert(deleteNonEmptyThrew, "deleteTrack strictly blocks deletion of non-empty track");

  // 12. Deleting nonexistent track throws
  let deleteMissingThrew = false;
  try {
    deleteTrack(tmTl, "tr_nonexistent");
  } catch (e: any) {
    deleteMissingThrew = true;
  }
  assert(deleteMissingThrew, "deleteTrack throws on nonexistent track ID");

  // 13. Playback priority updating deterministically when video tracks are reordered
  let twoVidTl = createEmptyTimeline({ projectId: "tv_proj" });
  twoVidTl = addTrack(twoVidTl, { id: "tr_vid_A", name: "Video A", type: "video" });
  twoVidTl = addTrack(twoVidTl, { id: "tr_vid_B", name: "Video B", type: "video" });
  twoVidTl = addClip(twoVidTl, {
    id: "clip_A",
    assetId: videoAsset.id,
    trackId: "tr_vid_A",
    sourceStart: 0,
    sourceEnd: 15,
    timelineStart: 0
  }, { assets: [videoAsset] });
  twoVidTl = addClip(twoVidTl, {
    id: "clip_B",
    assetId: videoAsset.id,
    trackId: "tr_vid_B",
    sourceStart: 5,
    sourceEnd: 20,
    timelineStart: 0
  }, { assets: [videoAsset] });

  // Initially: Video A is at index 0, Video B is at index 1
  const pbSnap1 = getTimelinePlaybackSnapshot(twoVidTl, 2.0);
  assert(pbSnap1.activeClip?.clip.id === "clip_A", "Initially Video A at index 0 has playback priority");

  // Move Video B up to index 0 (Video A moves to index 1)
  const reorderedPlaybackTl = reorderTrack(twoVidTl, "tr_vid_B", "up");
  assert(reorderedPlaybackTl.tracks[0].id === "tr_vid_B", "Video B is now at index 0");
  assert(reorderedPlaybackTl.tracks[1].id === "tr_vid_A", "Video A is now at index 1");

  const pbSnap2 = getTimelinePlaybackSnapshot(reorderedPlaybackTl, 2.0);
  assert(pbSnap2.activeClip?.clip.id === "clip_B", "After moving Video B to index 0, Video B takes topmost playback priority");

  // [Test 20] Render Plan Generation and Validation (Step 4.1)
  const renderRes = runRenderTests();
  passed += renderRes.passed;
  failed += renderRes.failed;

  console.log(`\n=== Timeline Test Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

try {
  runTimelineTests();
} catch (err) {
  console.error("Test execution threw error:", err);
  process.exit(1);
}
