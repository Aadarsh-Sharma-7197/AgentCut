import {
  createEmptyTimeline,
  addTrack,
  addClip,
  removeClip,
  moveClip,
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
