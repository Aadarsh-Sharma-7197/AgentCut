import { Collection, ObjectId } from "mongodb";
import fs from "fs";
import { getDB } from "../config/db.js";
import {
  resolveStoredFilePath,
  resolveAssetAnalysisAudioPath,
  resolveAssetTranscriptPath,
  resolveSceneFramePath
} from "../config/storage.js";
import { MediaAssetDocument } from "../models/media.model.js";
import { AudioExtractionDocument } from "../models/audio-extraction.model.js";
import { SilenceDetectionDocument } from "../models/silence-detection.model.js";
import { TranscriptionDocument } from "../models/transcription.model.js";
import { SceneDetectionDocument } from "../models/scene-detection.model.js";
import { inspectVideo } from "../utils/ffprobe.js";
import type {
  AnalysisModalityStatus,
  UnifiedIntelligenceStatus,
  UnifiedMediaIntelligenceManifest,
  TimelineQueryOptions,
  UnifiedTimelineSlice,
  UnifiedTimelineResponse,
  TimelineSliceScene,
  TimelineSliceSpeechWord,
  TranscriptData,
  Scene
} from "@agentcut/shared";

const MEDIA_COLLECTION = "media_assets";
const AUDIO_COLLECTION = "audio_extractions";
const SILENCE_COLLECTION = "silence_detections";
const TRANSCRIPTION_COLLECTION = "transcriptions";
const SCENES_COLLECTION = "scene_detections";

export const MAX_TIMELINE_WINDOW_SECONDS = 3600;
export const MAX_RAW_BOUNDARY_CANDIDATES = 4000;
export const MAX_UNIQUE_BOUNDARIES = 2001;

function getMediaCollection(): Collection<MediaAssetDocument> {
  return getDB().collection<MediaAssetDocument>(MEDIA_COLLECTION);
}

function getAudioCollection(): Collection<AudioExtractionDocument> {
  return getDB().collection<AudioExtractionDocument>(AUDIO_COLLECTION);
}

function getSilenceCollection(): Collection<SilenceDetectionDocument> {
  return getDB().collection<SilenceDetectionDocument>(SILENCE_COLLECTION);
}

function getTranscriptionCollection(): Collection<TranscriptionDocument> {
  return getDB().collection<TranscriptionDocument>(TRANSCRIPTION_COLLECTION);
}

function getScenesCollection(): Collection<SceneDetectionDocument> {
  return getDB().collection<SceneDetectionDocument>(SCENES_COLLECTION);
}

/**
 * Rounds a number to 3 decimal places for serialization.
 */
export function round3(val: number): number {
  return Math.round(val * 1000) / 1000;
}

/**
 * Performs lightweight structural validation of a JPEG frame artifact.
 * Verifies file existence, size >= 128 bytes, and JPEG SOI (0xFF, 0xD8) and EOI (0xFF, 0xD9) markers.
 * NOTE: This is bounded structural validation, not full bitmap image decoding.
 */
export async function verifyJpegFrameStructural(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size < 128) {
      return false;
    }

    const fd = await fs.promises.open(filePath, "r");
    try {
      const header = Buffer.alloc(2);
      await fd.read(header, 0, 2, 0);
      if (header[0] !== 0xff || header[1] !== 0xd8) {
        return false;
      }

      const footer = Buffer.alloc(2);
      await fd.read(footer, 0, 2, stat.size - 2);
      return footer[0] === 0xff && footer[1] === 0xd9;
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

/**
 * Validates frame structural integrity with request-scoped caching to prevent redundant disk I/O.
 */
export async function checkFrameStructuralIntegrityCached(
  filePath: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  if (cache.has(filePath)) {
    return cache.get(filePath)!;
  }
  const isValid = await verifyJpegFrameStructural(filePath);
  cache.set(filePath, isValid);
  return isValid;
}

/**
 * Calculates the exact union duration of speech intervals to prevent double-counting.
 * Merges overlapping and touching intervals, preserving full precision.
 */
export function calculateSpeechUnionDuration(intervals: Array<{ start: number; end: number }>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let union = 0;
  let currentStart = sorted[0].start;
  let currentEnd = sorted[0].end;

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, next.end);
    } else {
      union += currentEnd - currentStart;
      currentStart = next.start;
      currentEnd = next.end;
    }
  }
  union += currentEnd - currentStart;
  return union;
}

/**
 * Evaluates the overall intelligence status across applicable modalities according to strict precedence rules:
 * 1. completed: every applicable modality completed.
 * 2. empty: all applicable modalities are not_started.
 * 3. partial: at least one modality completed, but not all applicable modalities completed.
 * 4. processing: no completed modality exists, and at least one modality is queued or processing.
 * 5. canceled: all applicable modalities are terminal and all are canceled (or canceled + not_started without failed).
 * 6. failed: all applicable modalities are terminal, none completed, and at least one is failed.
 */
export function evaluateOverallIntelligenceStatus(
  modalityStatuses: Record<string, AnalysisModalityStatus>,
  applicableModalities: string[]
): UnifiedIntelligenceStatus {
  const applicable = applicableModalities.map((m) => modalityStatuses[m] || "not_started");
  if (applicable.length === 0) return "empty";

  if (applicable.every((s) => s === "completed")) {
    return "completed";
  }

  if (applicable.every((s) => s === "not_started")) {
    return "empty";
  }

  if (applicable.some((s) => s === "completed")) {
    return "partial";
  }

  if (applicable.some((s) => s === "queued" || s === "processing")) {
    return "processing";
  }

  const nonNotStarted = applicable.filter((s) => s !== "not_started");
  if (nonNotStarted.length > 0 && nonNotStarted.every((s) => s === "canceled")) {
    return "canceled";
  }

  if (applicable.some((s) => s === "failed")) {
    return "failed";
  }

  return "empty";
}

/**
 * Distinguishes confirmed no-audio from unprobed or unknown audio metadata.
 * Uses in-memory FFprobe fallback if audioCodec is undefined, without mutating MongoDB.
 */
export async function resolveAudioStreamInfo(
  projectId: string,
  mediaDoc: MediaAssetDocument
): Promise<{ hasAudio: boolean | null; audioCodec: string | null }> {
  // If audioCodec is explicitly null, absence of audio was confirmed during upload inspection
  if (mediaDoc.audioCodec === null) {
    return { hasAudio: false, audioCodec: null };
  }

  // If audioCodec is a non-empty string, audio presence is confirmed
  if (typeof mediaDoc.audioCodec === "string" && mediaDoc.audioCodec.trim().length > 0) {
    return { hasAudio: true, audioCodec: mediaDoc.audioCodec.trim() };
  }

  // If audioCodec is undefined or missing, attempt in-memory probe fallback without mutating DB
  try {
    const mediaPath = resolveStoredFilePath(projectId, mediaDoc.storedFileName);
    if (fs.existsSync(mediaPath)) {
      const probeResult = await inspectVideo(mediaPath);
      if (typeof probeResult.audioCodec === "string" && probeResult.audioCodec.trim().length > 0) {
        return { hasAudio: true, audioCodec: probeResult.audioCodec.trim() };
      } else if (probeResult.audioCodec === null) {
        return { hasAudio: false, audioCodec: null };
      }
    }
  } catch {
    // Media file inaccessible or probing failed; stream availability remains unknown
  }

  // Fallback: stream availability is unknown
  return { hasAudio: null, audioCodec: null };
}

/**
 * Retrieves the unified media intelligence manifest for a media asset.
 * Strictly read-only: performs zero database mutations.
 */
export async function getMediaIntelligenceManifest(
  projectId: string,
  assetId: string
): Promise<UnifiedMediaIntelligenceManifest | null> {
  if (!ObjectId.isValid(projectId) || !ObjectId.isValid(assetId)) {
    return null;
  }

  const mediaDoc = await getMediaCollection().findOne({
    _id: new ObjectId(assetId),
    projectId
  });

  if (!mediaDoc) {
    return null;
  }

  // Execute parallel indexed queries across all analysis collections
  const [audioDoc, silenceDoc, transcriptionDoc, scenesDoc] = await Promise.all([
    getAudioCollection().findOne({ projectId, assetId }),
    getSilenceCollection().findOne({ projectId, assetId }),
    getTranscriptionCollection().findOne({ projectId, assetId }),
    getScenesCollection().findOne({ projectId, assetId, status: "completed" }, { sort: { createdAt: -1 } })
      .then(async (doc) => {
        if (doc) return doc;
        return getScenesCollection().findOne({ projectId, assetId }, { sort: { createdAt: -1 } });
      })
  ]);

  // Determine audio stream availability safely
  const { hasAudio, audioCodec } = await resolveAudioStreamInfo(projectId, mediaDoc);

  // Determine applicable modalities
  // If hasAudio === false: only scenes is applicable; audio modalities are no_stream
  // If hasAudio === true or null (unknown): audio modalities remain applicable
  const isConfirmedNoAudio = hasAudio === false;
  const applicableModalities = isConfirmedNoAudio
    ? ["scenes"]
    : ["audio", "silence", "transcription", "scenes"];

  // 1. Evaluate Audio extraction modality
  let audioStatus: AnalysisModalityStatus = "not_started";
  let audioHasArtifact: boolean | undefined = undefined;
  let audioError: string | undefined = undefined;

  if (isConfirmedNoAudio) {
    audioStatus = "no_stream";
  } else if (audioDoc) {
    if (audioDoc.status === "completed") {
      const audioPath = resolveAssetAnalysisAudioPath(projectId, assetId);
      if (fs.existsSync(audioPath)) {
        audioStatus = "completed";
        audioHasArtifact = true;
      } else {
        audioStatus = "failed";
        audioHasArtifact = false;
        audioError = "Audio artifact is missing or inaccessible on server";
      }
    } else if (audioDoc.status === "extracting") {
      audioStatus = "processing";
    } else if (audioDoc.status === "queued") {
      audioStatus = "queued";
    } else if (audioDoc.status === "no_audio") {
      audioStatus = "no_stream";
    } else if (audioDoc.status === "failed") {
      audioStatus = "failed";
      audioError = audioDoc.error ? "Audio extraction failed on server" : undefined;
    }
  }

  // 2. Evaluate Silence detection modality
  let silenceStatus: AnalysisModalityStatus = "not_started";
  let silenceIntervalCount: number | undefined = undefined;
  let totalSilenceDuration: number | undefined = undefined;
  let silenceError: string | undefined = undefined;

  if (isConfirmedNoAudio) {
    silenceStatus = "no_stream";
  } else if (silenceDoc) {
    if (silenceDoc.status === "completed") {
      silenceStatus = "completed";
      silenceIntervalCount = (silenceDoc.intervals || []).length;
      totalSilenceDuration = round3(silenceDoc.totalSilenceDuration ?? 0);
    } else if (silenceDoc.status === "detecting") {
      silenceStatus = "processing";
    } else if (silenceDoc.status === "failed") {
      silenceStatus = "failed";
      silenceError = silenceDoc.error ? "Silence detection failed on server" : undefined;
    }
  }

  // 3. Evaluate Transcription modality
  let transcriptionStatus: AnalysisModalityStatus = "not_started";
  let wordCount: number | undefined = undefined;
  let segmentCount: number | undefined = undefined;
  let speechDuration: number | undefined = undefined;
  let detectedLanguage: string | undefined = undefined;
  let txHasArtifact: boolean | undefined = undefined;
  let transcriptionError: string | undefined = undefined;

  if (isConfirmedNoAudio) {
    transcriptionStatus = "no_stream";
  } else if (transcriptionDoc) {
    if (transcriptionDoc.status === "completed") {
      const transcriptPath = resolveAssetTranscriptPath(projectId, assetId);
      if (fs.existsSync(transcriptPath)) {
        try {
          const raw = await fs.promises.readFile(transcriptPath, "utf-8");
          const parsed = JSON.parse(raw) as TranscriptData;
          txHasArtifact = true;
          transcriptionStatus = "completed";
          segmentCount = parsed.segments?.length ?? transcriptionDoc.segmentCount ?? 0;
          detectedLanguage = parsed.language || transcriptionDoc.detectedLanguage;

          // Collect word count and calculate union speech duration
          const words = (parsed.segments || []).flatMap((s) => s.words || []);
          wordCount = words.length;

          const intervals = (parsed.segments || []).map((s) => ({ start: s.start, end: s.end }));
          speechDuration = round3(calculateSpeechUnionDuration(intervals));
        } catch {
          transcriptionStatus = "failed";
          txHasArtifact = false;
          transcriptionError = "Transcription artifact is missing or corrupted on server";
        }
      } else {
        transcriptionStatus = "failed";
        txHasArtifact = false;
        transcriptionError = "Transcription artifact is missing or inaccessible on server";
      }
    } else if (transcriptionDoc.status === "processing") {
      transcriptionStatus = "processing";
    } else if (transcriptionDoc.status === "queued") {
      transcriptionStatus = "queued";
    } else if (transcriptionDoc.status === "canceled") {
      transcriptionStatus = "canceled";
    } else if (transcriptionDoc.status === "failed") {
      transcriptionStatus = "failed";
      transcriptionError = transcriptionDoc.error ? "Transcription failed on server" : undefined;
    }
  }

  // 4. Evaluate Scene detection modality
  let sceneStatus: AnalysisModalityStatus = "not_started";
  let sceneCount: number | undefined = undefined;
  let sceneAnalysisId: string | undefined = undefined;
  let sceneError: string | undefined = undefined;
  const frameCache = new Map<string, boolean>();

  if (scenesDoc) {
    sceneAnalysisId = scenesDoc._id.toHexString();
    if (scenesDoc.status === "completed") {
      const scenesList = scenesDoc.scenes || [];
      sceneCount = scenesDoc.sceneCount ?? scenesList.length;

      // Verify each referenced scene frame using bounded structural validation
      let allFramesValid = true;
      for (const scene of scenesList) {
        const framePath = resolveSceneFramePath(projectId, assetId, sceneAnalysisId, scene.id);
        const valid = await checkFrameStructuralIntegrityCached(framePath, frameCache);
        if (!valid) {
          allFramesValid = false;
          break;
        }
      }

      if (allFramesValid) {
        sceneStatus = "completed";
      } else {
        sceneStatus = "failed";
        sceneError = "Scene frame artifact is missing or corrupted on server";
      }
    } else if (scenesDoc.status === "detecting") {
      sceneStatus = "processing";
    } else if (scenesDoc.status === "canceled") {
      sceneStatus = "canceled";
    } else if (scenesDoc.status === "failed") {
      sceneStatus = "failed";
      sceneError = scenesDoc.error ? "Scene detection failed on server" : undefined;
    }
  }

  // Evaluate overall status across applicable modalities
  const modalityStatuses: Record<string, AnalysisModalityStatus> = {
    audio: audioStatus,
    silence: silenceStatus,
    transcription: transcriptionStatus,
    scenes: sceneStatus
  };

  const overallStatus = evaluateOverallIntelligenceStatus(modalityStatuses, applicableModalities);

  // Aggregated durations and coverage ratios
  const totalDuration = round3(mediaDoc.duration || 0);
  const finalSilenceDuration = totalSilenceDuration ?? 0;
  const finalSpeechDuration = speechDuration ?? 0;

  const speechCoverageRatio =
    totalDuration > 0 ? round3(Math.min(1, finalSpeechDuration / totalDuration)) : 0;
  const silenceCoverageRatio =
    totalDuration > 0 ? round3(Math.min(1, finalSilenceDuration / totalDuration)) : 0;

  // Frame rate parsing
  let fps = 30;
  if (typeof mediaDoc.frameRate === "string") {
    if (mediaDoc.frameRate.includes("/")) {
      const [num, den] = mediaDoc.frameRate.split("/").map(Number);
      if (den && !isNaN(num) && !isNaN(den)) {
        fps = round3(num / den);
      }
    } else {
      const parsedFps = parseFloat(mediaDoc.frameRate);
      if (!isNaN(parsedFps) && parsedFps > 0) {
        fps = round3(parsedFps);
      }
    }
  }

  return {
    projectId,
    assetId,
    duration: totalDuration,
    hasAudio,
    videoCodec: mediaDoc.videoCodec || "unknown",
    audioCodec,
    resolution: {
      width: mediaDoc.width || 0,
      height: mediaDoc.height || 0
    },
    fps,
    overallStatus,
    modalities: {
      audio: {
        status: audioStatus,
        hasArtifact: audioHasArtifact,
        error: audioError
      },
      silence: {
        status: silenceStatus,
        intervalCount: silenceIntervalCount,
        totalSilenceDuration,
        error: silenceError
      },
      transcription: {
        status: transcriptionStatus,
        wordCount,
        segmentCount,
        speechDuration,
        detectedLanguage,
        hasArtifact: txHasArtifact,
        error: transcriptionError
      },
      scenes: {
        status: sceneStatus,
        sceneCount,
        analysisId: sceneAnalysisId,
        error: sceneError
      }
    },
    aggregated: {
      totalDuration,
      speechDuration: finalSpeechDuration,
      silenceDuration: finalSilenceDuration,
      speechCoverageRatio,
      silenceCoverageRatio
    }
  };
}

export interface ValidatedTimelineParams {
  start: number;
  end: number;
  include: Set<"scenes" | "speech" | "silence">;
}

/**
 * Validates timeline query options and returns parsed parameters or throws an HTTP 400 error.
 */
export function validateTimelineQueryOptions(
  mediaDuration: number,
  options: TimelineQueryOptions
): ValidatedTimelineParams {
  let start = options.start !== undefined ? Number(options.start) : 0;
  let end = options.end !== undefined ? Number(options.end) : mediaDuration;

  if (isNaN(start) || !isFinite(start) || start < 0) {
    throw new Error(
      "Invalid time range: start must be non-negative and less than end, and start must be within media duration"
    );
  }

  if (isNaN(end) || !isFinite(end) || end <= 0) {
    throw new Error(
      "Invalid time range: start must be non-negative and less than end, and start must be within media duration"
    );
  }

  if (start >= end || start >= mediaDuration) {
    throw new Error(
      "Invalid time range: start must be non-negative and less than end, and start must be within media duration"
    );
  }

  // Maximum 1-hour window check (checked on requested range before clamping)
  if (end - start > MAX_TIMELINE_WINDOW_SECONDS) {
    throw new Error(
      `Requested timeline window exceeds maximum allowed duration of ${MAX_TIMELINE_WINDOW_SECONDS} seconds (1 hour)`
    );
  }

  // Clamp end to media duration if it exceeds it
  if (end > mediaDuration) {
    end = mediaDuration;
  }

  // Parse and validate include parameter
  const includeSet = new Set<"scenes" | "speech" | "silence">();
  if (!options.include || options.include.trim() === "") {
    includeSet.add("scenes");
    includeSet.add("speech");
    includeSet.add("silence");
  } else {
    const tokens = options.include
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    for (const token of tokens) {
      if (token === "scenes" || token === "speech" || token === "silence") {
        includeSet.add(token);
      } else {
        throw new Error("Invalid include parameter. Supported values: scenes, speech, silence");
      }
    }
  }

  return {
    start,
    end,
    include: includeSet
  };
}

/**
 * Generates the unified timeline slicing representation for a media asset.
 * Strictly read-only: performs zero database mutations.
 */
export async function getMediaIntelligenceTimeline(
  projectId: string,
  assetId: string,
  options: TimelineQueryOptions
): Promise<UnifiedTimelineResponse> {
  if (!ObjectId.isValid(projectId) || !ObjectId.isValid(assetId)) {
    throw new Error("Invalid project ID or asset ID format.");
  }

  const mediaDoc = await getMediaCollection().findOne({
    _id: new ObjectId(assetId),
    projectId
  });

  if (!mediaDoc) {
    throw new Error("Media asset not found in this project.");
  }

  const mediaDuration = mediaDoc.duration || 0;
  const { start: windowStart, end: windowEnd, include } = validateTimelineQueryOptions(
    mediaDuration,
    options
  );

  // Parallel retrieval of required analysis data
  const [silenceDoc, transcriptionDoc, scenesDoc] = await Promise.all([
    include.has("silence")
      ? getSilenceCollection().findOne({ projectId, assetId, status: "completed" })
      : Promise.resolve(null),
    include.has("speech")
      ? getTranscriptionCollection().findOne({ projectId, assetId, status: "completed" })
      : Promise.resolve(null),
    include.has("scenes")
      ? getScenesCollection().findOne(
          { projectId, assetId, status: "completed" },
          { sort: { createdAt: -1 } }
        )
      : Promise.resolve(null)
  ]);

  // Load transcript words if speech is included
  interface ExtractedWord {
    word: string;
    start: number;
    end: number;
    confidence?: number;
  }
  const speechWords: ExtractedWord[] = [];

  if (include.has("speech") && transcriptionDoc) {
    const transcriptPath = resolveAssetTranscriptPath(projectId, assetId);
    if (fs.existsSync(transcriptPath)) {
      try {
        const raw = await fs.promises.readFile(transcriptPath, "utf-8");
        const parsed = JSON.parse(raw) as TranscriptData;
        for (const seg of parsed.segments || []) {
          for (const w of seg.words || []) {
            if (typeof w.start === "number" && typeof w.end === "number" && w.end > w.start) {
              speechWords.push({
                word: w.word,
                start: w.start,
                end: w.end,
                confidence: w.probability
              });
            }
          }
        }
      } catch {
        // Transcript read error; proceed without speech words
      }
    }
  }

  // Load scenes if scenes is included
  const scenesList: Scene[] = include.has("scenes") && scenesDoc ? scenesDoc.scenes || [] : [];
  const sceneAnalysisId = scenesDoc ? scenesDoc._id.toHexString() : "";

  // Load silence intervals if silence is included
  const silenceIntervals =
    include.has("silence") && silenceDoc ? silenceDoc.intervals || [] : [];

  // -------------------------------------------------------------
  // Boundary Collection with Early Abort
  // -------------------------------------------------------------
  const rawBoundaries: number[] = [windowStart, windowEnd];
  let rawCount = 2;

  // Collect scene boundaries within window
  if (include.has("scenes")) {
    for (const s of scenesList) {
      if (s.start > windowStart && s.start < windowEnd) {
        rawBoundaries.push(s.start);
        rawCount++;
      }
      if (s.end > windowStart && s.end < windowEnd) {
        rawBoundaries.push(s.end);
        rawCount++;
      }
      if (rawCount > MAX_RAW_BOUNDARY_CANDIDATES) {
        throw new Error(
          `Timeline query produced more than 2000 slices (exceeded raw boundary limit of ${MAX_RAW_BOUNDARY_CANDIDATES}). Please narrow start and end window or filter modalities with include.`
        );
      }
    }
  }

  // Collect speech word boundaries within window
  if (include.has("speech")) {
    for (const w of speechWords) {
      if (w.start > windowStart && w.start < windowEnd) {
        rawBoundaries.push(w.start);
        rawCount++;
      }
      if (w.end > windowStart && w.end < windowEnd) {
        rawBoundaries.push(w.end);
        rawCount++;
      }
      if (rawCount > MAX_RAW_BOUNDARY_CANDIDATES) {
        throw new Error(
          `Timeline query produced more than 2000 slices (exceeded raw boundary limit of ${MAX_RAW_BOUNDARY_CANDIDATES}). Please narrow start and end window or filter modalities with include.`
        );
      }
    }
  }

  // Collect silence boundaries within window
  if (include.has("silence")) {
    for (const sil of silenceIntervals) {
      if (sil.start > windowStart && sil.start < windowEnd) {
        rawBoundaries.push(sil.start);
        rawCount++;
      }
      if (sil.end > windowStart && sil.end < windowEnd) {
        rawBoundaries.push(sil.end);
        rawCount++;
      }
      if (rawCount > MAX_RAW_BOUNDARY_CANDIDATES) {
        throw new Error(
          `Timeline query produced more than 2000 slices (exceeded raw boundary limit of ${MAX_RAW_BOUNDARY_CANDIDATES}). Please narrow start and end window or filter modalities with include.`
        );
      }
    }
  }

  // Exact numeric deduplication and sorting (no heuristic epsilon merging)
  const uniqueBoundaries = Array.from(new Set(rawBoundaries)).sort((a, b) => a - b);

  if (uniqueBoundaries.length > MAX_UNIQUE_BOUNDARIES) {
    throw new Error(
      `Timeline query produced more than 2000 slices (found ${uniqueBoundaries.length - 1} slices). Please narrow start and end window or filter modalities with include.`
    );
  }

  // -------------------------------------------------------------
  // Slice Construction
  // -------------------------------------------------------------
  const slices: UnifiedTimelineSlice[] = [];
  const frameCache = new Map<string, boolean>();

  for (let i = 0; i < uniqueBoundaries.length - 1; i++) {
    const bStart = uniqueBoundaries[i];
    const bEnd = uniqueBoundaries[i + 1];

    // Emit a slice whenever full-precision end > start
    if (bEnd <= bStart) {
      continue;
    }

    const midpoint = bStart + (bEnd - bStart) / 2;

    // 1. Scene coverage: select scene covering slice midpoint
    let sceneData: TimelineSliceScene | undefined = undefined;
    if (include.has("scenes") && scenesList.length > 0) {
      const matchingScene = scenesList.find((s) => {
        // Half-open interval [s.start, s.end), with final scene inclusive of media duration
        return s.start <= midpoint && (midpoint < s.end || (s.end >= mediaDuration && midpoint <= s.end));
      });

      if (matchingScene) {
        const framePath = resolveSceneFramePath(
          projectId,
          assetId,
          sceneAnalysisId,
          matchingScene.id
        );
        const isFrameValid = await checkFrameStructuralIntegrityCached(framePath, frameCache);

        sceneData = {
          sceneId: matchingScene.id,
          index: matchingScene.index,
          frameUrl: isFrameValid
            ? `/api/projects/${projectId}/media/${assetId}/scenes/analyses/${sceneAnalysisId}/frames/${matchingScene.id}`
            : null
        };
      }
    }

    // 2. Speech words: include every speech word overlapping the slice [bStart, bEnd)
    let wordsData: TimelineSliceSpeechWord[] | undefined = undefined;
    if (include.has("speech")) {
      const overlapping = speechWords.filter((w) => {
        return Math.max(bStart, w.start) < Math.min(bEnd, w.end);
      });

      wordsData = overlapping.map((w) => ({
        word: w.word,
        start: round3(w.start),
        end: round3(w.end),
        confidence: w.confidence !== undefined ? round3(w.confidence) : undefined
      }));
    }

    // 3. Silence: isSilence is true if any silence interval overlaps the slice
    let isSilence: boolean | undefined = undefined;
    if (include.has("silence")) {
      isSilence = silenceIntervals.some((sil) => {
        return Math.max(bStart, sil.start) < Math.min(bEnd, sil.end);
      });
    }

    slices.push({
      start: round3(bStart),
      end: round3(bEnd),
      duration: round3(bEnd - bStart),
      scene: sceneData,
      speechWords: wordsData,
      isSilence
    });
  }

  return {
    window: {
      start: round3(windowStart),
      end: round3(windowEnd),
      duration: round3(windowEnd - windowStart)
    },
    totalSlices: slices.length,
    slices
  };
}

