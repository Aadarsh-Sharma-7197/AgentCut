import {
  createEmptyTimeline,
  addTrack,
  addClip,
  removeClip,
  moveClip,
  splitClip,
  splitClipWithResult,
  validateTimeline,
  validateClip,
  validateTrack,
  getClipDuration,
  getClipTimelineEnd,
  getTimelineDuration,
  TimelineValidationError,
  type Timeline,
  type MediaAsset
} from "./index.js";

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
