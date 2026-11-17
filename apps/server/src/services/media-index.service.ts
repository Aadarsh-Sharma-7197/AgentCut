import { Collection, ObjectId } from "mongodb";
import fs from "fs";
import { getDB } from "../config/db.js";
import { resolveAssetTranscriptPath, resolveSceneFramePath } from "../config/storage.js";
import { MediaAssetDocument } from "../models/media.model.js";
import { SilenceDetectionDocument } from "../models/silence-detection.model.js";
import { TranscriptionDocument } from "../models/transcription.model.js";
import { SceneDetectionDocument } from "../models/scene-detection.model.js";
import { checkFrameStructuralIntegrityCached } from "./media-intelligence.service.js";
import type {
  TranscriptData,
  TranscriptSegment,
  TranscriptWord,
  SpeechSearchWord,
  SpeechSearchMatch,
  SpeechSearchResponse,
  SilenceSearchMatch,
  SilenceSearchResponse,
  SceneSearchMatch,
  SceneSearchResponse,
  UnifiedAssetSearchMatch,
  UnifiedAssetSearchResponse,
  UnsearchableAssetInfo,
  ProjectIntelligenceSearchResponse
} from "@agentcut/shared";

const MEDIA_COLLECTION = "media_assets";
const SILENCE_COLLECTION = "silence_detections";
const TRANSCRIPTION_COLLECTION = "transcriptions";
const SCENES_COLLECTION = "scene_detections";

export const MAX_QUERY_STRING_LENGTH = 100;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_ELIGIBLE_ASSETS_PER_REQUEST = 100;
export const MAX_CONCURRENT_ARTIFACT_READS = 5;
export const MAX_INDIVIDUAL_ARTIFACT_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_AGGREGATE_ARTIFACT_READ_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_MATCH_BUDGET = 5000;
export const MAX_WORD_GAP_SECONDS = 2.0;

const LEADING_PUNCT_REGEX = /^[\.,\/#!$%\^&\*;:{}=\-_`~()?"'’“”«»]+/;
const TRAILING_PUNCT_REGEX = /[\.,\/#!$%\^&\*;:{}=\-_`~()?"'’“”«»]+$/;

export class SearchError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SearchError";
    this.statusCode = statusCode;
  }
}

function getMediaCollection(): Collection<MediaAssetDocument> {
  return getDB().collection<MediaAssetDocument>(MEDIA_COLLECTION);
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
 * Normalizes a raw token by stripping leading and trailing punctuation,
 * applying Unicode NFC normalization, and converting to lowercase.
 * Internal hyphens and apostrophes (e.g. "state-of-the-art", "don't") are preserved.
 */
export function normalizeToken(rawToken: string): string {
  return rawToken
    .replace(LEADING_PUNCT_REGEX, "")
    .replace(TRAILING_PUNCT_REGEX, "")
    .normalize("NFC")
    .toLowerCase();
}

/**
 * Validates and normalizes a search query string.
 * Rejects empty queries, queries exceeding 100 characters, and queries with no alphanumeric tokens.
 */
export function validateAndTokenizeQuery(q: unknown): string[] {
  if (typeof q !== "string" || q.trim().length === 0) {
    throw new SearchError(400, "Query string parameter 'q' is required.");
  }
  if (q.length > MAX_QUERY_STRING_LENGTH) {
    throw new SearchError(400, `Query string exceeds maximum length of ${MAX_QUERY_STRING_LENGTH} characters.`);
  }

  const rawTokens = q.trim().split(/\s+/);
  const cleanedTokens = rawTokens.map(normalizeToken).filter((t) => t.length > 0);

  if (cleanedTokens.length === 0) {
    throw new SearchError(400, "Query must contain at least one alphanumeric token.");
  }

  return cleanedTokens;
}

/**
 * Validates pagination parameters: limit (1..200, default 50) and offset (>=0, default 0).
 */
export function validatePagination(
  limitParam?: unknown,
  offsetParam?: unknown
): { limit: number; offset: number } {
  let limit = DEFAULT_PAGE_LIMIT;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      throw new SearchError(400, `Invalid limit parameter. Must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
    }
    limit = parsed;
  }

  let offset = 0;
  if (offsetParam !== undefined) {
    const parsed = Number(offsetParam);
    if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      throw new SearchError(400, "Invalid offset parameter. Must be a non-negative integer.");
    }
    offset = parsed;
  }

  return { limit, offset };
}

/**
 * Validates time window parameters [start, end).
 */
export function validateTimeWindow(
  startParam?: unknown,
  endParam?: unknown
): { start: number; end?: number } {
  let start = 0;
  if (startParam !== undefined) {
    const parsed = Number(startParam);
    if (isNaN(parsed) || parsed < 0) {
      throw new SearchError(400, "Invalid start time parameter. Must be greater than or equal to 0.");
    }
    start = parsed;
  }

  let end: number | undefined = undefined;
  if (endParam !== undefined) {
    const parsed = Number(endParam);
    if (isNaN(parsed) || parsed <= start) {
      throw new SearchError(400, "Invalid end time parameter. Must be greater than start.");
    }
    end = parsed;
  }

  return { start, end };
}

/**
 * Validates minDuration and maxDuration parameters for silence and scene search.
 */
export function validateDurationRange(
  minDurationParam?: unknown,
  maxDurationParam?: unknown
): { minDuration?: number; maxDuration?: number } {
  let minDuration: number | undefined = undefined;
  if (minDurationParam !== undefined) {
    const parsed = Number(minDurationParam);
    if (isNaN(parsed) || parsed <= 0) {
      throw new SearchError(400, "Invalid minDuration parameter. Must be greater than 0.");
    }
    minDuration = parsed;
  }

  let maxDuration: number | undefined = undefined;
  if (maxDurationParam !== undefined) {
    const parsed = Number(maxDurationParam);
    if (isNaN(parsed) || (minDuration !== undefined && parsed < minDuration)) {
      throw new SearchError(400, "Invalid maxDuration parameter. Must be greater than or equal to minDuration.");
    }
    maxDuration = parsed;
  }

  return { minDuration, maxDuration };
}

interface FlattenedWord {
  word: string;
  normalized: string;
  start: number;
  end: number;
  probability?: number;
  segmentId: number;
  segmentText: string;
  wordIndex: number;
}

/**
 * Extracts and flattens speech words from parsed transcript data with segment context.
 */
function extractFlattenedWords(transcriptData: TranscriptData): FlattenedWord[] {
  const result: FlattenedWord[] = [];
  let globalWordIndex = 0;

  for (const seg of transcriptData.segments || []) {
    const segText = seg.text || "";
    if (Array.isArray(seg.words) && seg.words.length > 0) {
      for (const w of seg.words) {
        if (typeof w.start === "number" && typeof w.end === "number" && w.end >= w.start) {
          result.push({
            word: w.word,
            normalized: normalizeToken(w.word),
            start: w.start,
            end: w.end,
            probability: w.probability,
            segmentId: seg.id,
            segmentText: segText,
            wordIndex: globalWordIndex++
          });
        }
      }
    } else if (segText.trim().length > 0 && typeof seg.start === "number" && typeof seg.end === "number" && seg.end > seg.start) {
      // Fallback interpolation if word timestamps are omitted
      const tokens = segText.trim().split(/\s+/);
      const durationPerWord = (seg.end - seg.start) / Math.max(1, tokens.length);
      for (let i = 0; i < tokens.length; i++) {
        const wStart = seg.start + i * durationPerWord;
        const wEnd = seg.start + (i + 1) * durationPerWord;
        result.push({
          word: tokens[i],
          normalized: normalizeToken(tokens[i]),
          start: Math.round(wStart * 1000) / 1000,
          end: Math.round(wEnd * 1000) / 1000,
          segmentId: seg.id,
          segmentText: segText,
          wordIndex: globalWordIndex++
        });
      }
    }
  }

  return result;
}

/**
 * Searches flattened transcript words for matching query tokens.
 * Supports exact & substring matching, consecutive word gap constraint (<= 2.0s),
 * half-open time window filtering [start, end), and strict match budget enforcement.
 */
export function searchWordsInTranscript(
  words: FlattenedWord[],
  queryTokens: string[],
  assetId: string,
  assetName: string,
  timeWindow: { start: number; end?: number },
  existingMatchCount: number = 0
): SpeechSearchMatch[] {
  const matches: SpeechSearchMatch[] = [];
  const K = queryTokens.length;
  let currentTotalMatches = existingMatchCount;

  for (let i = 0; i <= words.length - K; i++) {
    let matchValid = true;

    for (let k = 0; k < K; k++) {
      const qToken = queryTokens[k];
      const w = words[i + k];

      // Exact match OR substring match (e.g. "quality" within "high-quality")
      const isMatch = w.normalized === qToken || w.normalized.includes(qToken);
      if (!isMatch) {
        matchValid = false;
        break;
      }

      // Check consecutive word gap invariant (<= 2.0s) between adjacent words
      if (k > 0) {
        const prevWord = words[i + k - 1];
        const gap = w.start - prevWord.end;
        if (gap > MAX_WORD_GAP_SECONDS || w.start < prevWord.start) {
          matchValid = false;
          break;
        }
      }
    }

    if (matchValid) {
      const firstWord = words[i];
      const lastWord = words[i + K - 1];
      const matchStart = firstWord.start;
      const matchEnd = lastWord.end;

      // Half-open interval time window check [windowStart, windowEnd)
      // Non-empty overlap: max(windowStart, matchStart) < min(windowEnd, matchEnd)
      const windowEnd = timeWindow.end !== undefined ? timeWindow.end : Infinity;
      const overlapStart = Math.max(timeWindow.start, matchStart);
      const overlapEnd = Math.min(windowEnd, matchEnd);

      if (overlapStart < overlapEnd) {
        currentTotalMatches++;
        if (currentTotalMatches > MAX_MATCH_BUDGET) {
          throw new SearchError(
            400,
            `Query matched too many results (exceeded limit of ${MAX_MATCH_BUDGET} matches). Please refine your search query or specify a narrower time window.`
          );
        }

        const matchedWords: SpeechSearchWord[] = [];
        const segmentIdSet = new Set<number>();
        const segmentTexts: string[] = [];

        for (let k = 0; k < K; k++) {
          const w = words[i + k];
          matchedWords.push({
            word: w.word,
            start: w.start,
            end: w.end,
            probability: w.probability
          });
          segmentIdSet.add(w.segmentId);
          if (!segmentTexts.includes(w.segmentText)) {
            segmentTexts.push(w.segmentText);
          }
        }

        const segmentIds = Array.from(segmentIdSet).sort((a, b) => a - b);
        const matchedText = matchedWords.map((w) => w.word).join(" ");

        matches.push({
          id: `speech-${assetId}-s${firstWord.segmentId}-w${firstWord.wordIndex}`,
          type: "speech",
          assetId,
          assetName,
          start: matchStart,
          end: matchEnd,
          matchedText,
          segmentIds,
          segmentText: segmentTexts.join(" "),
          words: matchedWords
        });
      }
    }
  }

  return matches;
}

/**
 * Searches speech dialogue for a single media asset.
 * Enforces analysis lifecycle checks: queued/processing -> 409, completed -> searchable, failed -> 422, canceled/missing -> 400.
 */
export async function searchAssetSpeech(
  projectId: string,
  assetId: string,
  queryParams: {
    q?: unknown;
    start?: unknown;
    end?: unknown;
    limit?: unknown;
    offset?: unknown;
  }
): Promise<SpeechSearchResponse> {
  const queryTokens = validateAndTokenizeQuery(queryParams.q);
  const timeWindow = validateTimeWindow(queryParams.start, queryParams.end);
  const { limit, offset } = validatePagination(queryParams.limit, queryParams.offset);

  const mediaDoc = await getMediaCollection().findOne({ _id: new ObjectId(assetId), projectId });
  if (!mediaDoc) {
    throw new SearchError(404, "Media asset not found in this project.");
  }

  const transcriptionDoc = await getTranscriptionCollection().findOne({ projectId, assetId });
  if (!transcriptionDoc) {
    throw new SearchError(400, "Transcription analysis has not been performed for this media asset.");
  }

  if (transcriptionDoc.status === "queued" || transcriptionDoc.status === "processing") {
    throw new SearchError(409, "Transcription analysis is currently in progress for this media asset.");
  }
  if (transcriptionDoc.status === "failed") {
    throw new SearchError(422, "Transcription analysis failed or transcript artifact is unavailable for this media asset.");
  }
  if (transcriptionDoc.status === "canceled") {
    throw new SearchError(400, "Transcription analysis was canceled for this media asset.");
  }
  if (transcriptionDoc.status !== "completed") {
    throw new SearchError(400, `Transcription analysis has not completed (status: ${transcriptionDoc.status}).`);
  }

  const transcriptPath = resolveAssetTranscriptPath(projectId, assetId);
  if (!fs.existsSync(transcriptPath)) {
    throw new SearchError(422, "Transcription analysis failed or transcript artifact is unavailable for this media asset.");
  }

  let rawContent: string | undefined;
  let transcriptData: TranscriptData | undefined;
  let flattenedWords: FlattenedWord[] | undefined;
  let matches: SpeechSearchMatch[] = [];

  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size > MAX_INDIVIDUAL_ARTIFACT_BYTES) {
      throw new SearchError(400, `Transcript artifact file exceeds maximum size limit of ${MAX_INDIVIDUAL_ARTIFACT_BYTES / (1024 * 1024)}MB.`);
    }

    rawContent = await fs.promises.readFile(transcriptPath, "utf-8");
    transcriptData = JSON.parse(rawContent) as TranscriptData;
    flattenedWords = extractFlattenedWords(transcriptData);
    matches = searchWordsInTranscript(flattenedWords, queryTokens, assetId, mediaDoc.originalName, timeWindow);
  } catch (err) {
    if (err instanceof SearchError) throw err;
    throw new SearchError(422, "Failed to read or parse transcript artifact file.");
  } finally {
    // Explicit reference release for V8 GC eligibility
    rawContent = undefined;
    transcriptData = undefined;
    flattenedWords = undefined;
  }

  return {
    query: String(queryParams.q),
    assetId,
    assetName: mediaDoc.originalName,
    totalMatches: matches.length,
    limit,
    offset,
    matches: matches.slice(offset, offset + limit)
  };
}

/**
 * Searches silence intervals for a single media asset.
 */
export async function searchAssetSilence(
  projectId: string,
  assetId: string,
  queryParams: {
    minDuration?: unknown;
    maxDuration?: unknown;
    start?: unknown;
    end?: unknown;
    limit?: unknown;
    offset?: unknown;
  }
): Promise<SilenceSearchResponse> {
  const timeWindow = validateTimeWindow(queryParams.start, queryParams.end);
  const durationRange = validateDurationRange(queryParams.minDuration, queryParams.maxDuration);
  const { limit, offset } = validatePagination(queryParams.limit, queryParams.offset);

  const mediaDoc = await getMediaCollection().findOne({ _id: new ObjectId(assetId), projectId });
  if (!mediaDoc) {
    throw new SearchError(404, "Media asset not found in this project.");
  }

  const silenceDoc = await getSilenceCollection().findOne({ projectId, assetId });
  if (!silenceDoc) {
    throw new SearchError(400, "Silence detection analysis has not been performed for this media asset.");
  }

  if (silenceDoc.status === "detecting") {
    throw new SearchError(409, "Silence detection analysis is currently in progress for this media asset.");
  }
  if (silenceDoc.status === "failed") {
    throw new SearchError(422, "Silence detection analysis failed for this media asset.");
  }
  if (silenceDoc.status !== "completed") {
    throw new SearchError(400, `Silence detection analysis has not completed (status: ${silenceDoc.status}).`);
  }

  const matches: SilenceSearchMatch[] = [];
  const intervals = silenceDoc.intervals || [];
  const windowEnd = timeWindow.end !== undefined ? timeWindow.end : Infinity;

  for (let i = 0; i < intervals.length; i++) {
    const item = intervals[i];
    // Duration filter
    if (durationRange.minDuration !== undefined && item.duration < durationRange.minDuration) {
      continue;
    }
    if (durationRange.maxDuration !== undefined && item.duration > durationRange.maxDuration) {
      continue;
    }

    // Time window overlap [start, end)
    const overlapStart = Math.max(timeWindow.start, item.start);
    const overlapEnd = Math.min(windowEnd, item.end);
    if (overlapStart < overlapEnd) {
      if (matches.length >= MAX_MATCH_BUDGET) {
        throw new SearchError(
          400,
          `Query matched too many results (exceeded limit of ${MAX_MATCH_BUDGET} matches). Please refine your filter parameters.`
        );
      }
      matches.push({
        id: `silence-${assetId}-${i}`,
        type: "silence",
        assetId,
        start: item.start,
        end: item.end,
        duration: item.duration
      });
    }
  }

  return {
    assetId,
    totalMatches: matches.length,
    limit,
    offset,
    matches: matches.slice(offset, offset + limit)
  };
}

/**
 * Searches scene detection boundaries for a single media asset.
 * Validates frame structural integrity and reuses canonical frame endpoint.
 */
export async function searchAssetScenes(
  projectId: string,
  assetId: string,
  queryParams: {
    minDuration?: unknown;
    maxDuration?: unknown;
    start?: unknown;
    end?: unknown;
    limit?: unknown;
    offset?: unknown;
  }
): Promise<SceneSearchResponse> {
  const timeWindow = validateTimeWindow(queryParams.start, queryParams.end);
  const durationRange = validateDurationRange(queryParams.minDuration, queryParams.maxDuration);
  const { limit, offset } = validatePagination(queryParams.limit, queryParams.offset);

  const mediaDoc = await getMediaCollection().findOne({ _id: new ObjectId(assetId), projectId });
  if (!mediaDoc) {
    throw new SearchError(404, "Media asset not found in this project.");
  }

  const sceneDoc = await getScenesCollection().findOne(
    { projectId, assetId },
    { sort: { createdAt: -1 } }
  );
  if (!sceneDoc) {
    throw new SearchError(400, "Scene detection analysis has not been performed for this media asset.");
  }

  if (sceneDoc.status === "detecting") {
    throw new SearchError(409, "Scene detection analysis is currently in progress for this media asset.");
  }
  if (sceneDoc.status === "failed") {
    throw new SearchError(422, "Scene detection analysis failed for this media asset.");
  }
  if (sceneDoc.status === "canceled") {
    throw new SearchError(400, "Scene detection analysis was canceled for this media asset.");
  }
  if (sceneDoc.status !== "completed") {
    throw new SearchError(400, `Scene detection analysis has not completed (status: ${sceneDoc.status}).`);
  }

  const analysisId = sceneDoc._id.toHexString();
  const frameCache = new Map<string, boolean>();
  const matches: SceneSearchMatch[] = [];
  const scenes = sceneDoc.scenes || [];
  const windowEnd = timeWindow.end !== undefined ? timeWindow.end : Infinity;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    // Duration filter
    if (durationRange.minDuration !== undefined && s.duration < durationRange.minDuration) {
      continue;
    }
    if (durationRange.maxDuration !== undefined && s.duration > durationRange.maxDuration) {
      continue;
    }

    // Time window overlap [start, end)
    const overlapStart = Math.max(timeWindow.start, s.start);
    const overlapEnd = Math.min(windowEnd, s.end);
    if (overlapStart < overlapEnd) {
      if (matches.length >= MAX_MATCH_BUDGET) {
        throw new SearchError(
          400,
          `Query matched too many results (exceeded limit of ${MAX_MATCH_BUDGET} matches). Please refine your filter parameters.`
        );
      }

      // Canonical frame validation
      const framePath = resolveSceneFramePath(projectId, assetId, analysisId, s.id);
      const isFrameValid = await checkFrameStructuralIntegrityCached(framePath, frameCache);
      const canonicalFrameUrl = isFrameValid
        ? `/api/projects/${projectId}/media/${assetId}/scenes/frames/${s.id}`
        : null;

      matches.push({
        id: `scene-${assetId}-${s.index}`,
        type: "scene",
        assetId,
        sceneIndex: s.index,
        start: s.start,
        end: s.end,
        duration: s.duration,
        transitionType: "cut",
        frameUrl: canonicalFrameUrl
      });
    }
  }

  return {
    assetId,
    totalMatches: matches.length,
    limit,
    offset,
    matches: matches.slice(offset, offset + limit)
  };
}

/**
 * Unified asset search: searches speech dialogue enriched with containing scene context.
 */
export async function searchAssetUnified(
  projectId: string,
  assetId: string,
  queryParams: {
    q?: unknown;
    start?: unknown;
    end?: unknown;
    limit?: unknown;
    offset?: unknown;
  }
): Promise<UnifiedAssetSearchResponse> {
  const queryTokens = validateAndTokenizeQuery(queryParams.q);
  const timeWindow = validateTimeWindow(queryParams.start, queryParams.end);
  const { limit, offset } = validatePagination(queryParams.limit, queryParams.offset);

  const mediaDoc = await getMediaCollection().findOne({ _id: new ObjectId(assetId), projectId });
  if (!mediaDoc) {
    throw new SearchError(404, "Media asset not found in this project.");
  }

  // Primary modality: Speech transcription lifecycle
  const transcriptionDoc = await getTranscriptionCollection().findOne({ projectId, assetId });
  if (!transcriptionDoc) {
    throw new SearchError(400, "Transcription analysis has not been performed for this media asset.");
  }
  if (transcriptionDoc.status === "queued" || transcriptionDoc.status === "processing") {
    throw new SearchError(409, "Transcription analysis is currently in progress for this media asset.");
  }
  if (transcriptionDoc.status === "failed") {
    throw new SearchError(422, "Transcription analysis failed or transcript artifact is unavailable for this media asset.");
  }
  if (transcriptionDoc.status === "canceled") {
    throw new SearchError(400, "Transcription analysis was canceled for this media asset.");
  }
  if (transcriptionDoc.status !== "completed") {
    throw new SearchError(400, `Transcription analysis has not completed (status: ${transcriptionDoc.status}).`);
  }

  const transcriptPath = resolveAssetTranscriptPath(projectId, assetId);
  if (!fs.existsSync(transcriptPath)) {
    throw new SearchError(422, "Transcription analysis failed or transcript artifact is unavailable for this media asset.");
  }

  let rawContent: string | undefined;
  let transcriptData: TranscriptData | undefined;
  let flattenedWords: FlattenedWord[] | undefined;
  let speechMatches: SpeechSearchMatch[] = [];

  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size > MAX_INDIVIDUAL_ARTIFACT_BYTES) {
      throw new SearchError(400, `Transcript artifact file exceeds maximum size limit of ${MAX_INDIVIDUAL_ARTIFACT_BYTES / (1024 * 1024)}MB.`);
    }

    rawContent = await fs.promises.readFile(transcriptPath, "utf-8");
    transcriptData = JSON.parse(rawContent) as TranscriptData;
    flattenedWords = extractFlattenedWords(transcriptData);
    speechMatches = searchWordsInTranscript(flattenedWords, queryTokens, assetId, mediaDoc.originalName, timeWindow);
  } catch (err) {
    if (err instanceof SearchError) throw err;
    throw new SearchError(422, "Failed to read or parse transcript artifact file.");
  } finally {
    rawContent = undefined;
    transcriptData = undefined;
    flattenedWords = undefined;
  }

  // Secondary enrichment: Scene detection context
  const sceneDoc = await getScenesCollection().findOne(
    { projectId, assetId, status: "completed" },
    { sort: { createdAt: -1 } }
  );

  const sceneContextAvailable = Boolean(sceneDoc && sceneDoc.scenes && sceneDoc.scenes.length > 0);
  const frameCache = new Map<string, boolean>();
  const unifiedMatches: UnifiedAssetSearchMatch[] = [];

  for (const m of speechMatches) {
    let matchedSceneInfo: UnifiedAssetSearchMatch["scene"] = null;

    if (sceneContextAvailable && sceneDoc) {
      const midpoint = m.start + (m.end - m.start) / 2;
      const containingScene = (sceneDoc.scenes || []).find(
        (s) => s.start <= midpoint && (midpoint < s.end || (s.end >= (mediaDoc.duration || 0) && midpoint <= s.end))
      );

      if (containingScene) {
        const framePath = resolveSceneFramePath(
          projectId,
          assetId,
          sceneDoc._id.toHexString(),
          containingScene.id
        );
        const isFrameValid = await checkFrameStructuralIntegrityCached(framePath, frameCache);
        matchedSceneInfo = {
          sceneId: containingScene.id,
          index: containingScene.index,
          start: containingScene.start,
          end: containingScene.end,
          frameUrl: isFrameValid ? `/api/projects/${projectId}/media/${assetId}/scenes/frames/${containingScene.id}` : null
        };
      }
    }

    unifiedMatches.push({
      ...m,
      scene: matchedSceneInfo
    });
  }

  return {
    query: String(queryParams.q),
    assetId,
    assetName: mediaDoc.originalName,
    sceneContextAvailable,
    totalMatches: unifiedMatches.length,
    limit,
    offset,
    matches: unifiedMatches.slice(offset, offset + limit)
  };
}

/**
 * Project-wide cross-asset dialogue search.
 * Bounded concurrency (at most 5 concurrent reads), atomic byte reservation up to 100MB aggregate budget,
 * strict asset ownership validation, and comprehensive completeness metadata.
 */
export async function searchProjectIntelligence(
  projectId: string,
  queryParams: {
    q?: unknown;
    assetIds?: unknown;
    start?: unknown;
    end?: unknown;
    limit?: unknown;
    offset?: unknown;
  }
): Promise<ProjectIntelligenceSearchResponse> {
  const queryTokens = validateAndTokenizeQuery(queryParams.q);
  const timeWindow = validateTimeWindow(queryParams.start, queryParams.end);
  const { limit, offset } = validatePagination(queryParams.limit, queryParams.offset);

  // Validate assetIds if explicitly provided
  let targetAssets: MediaAssetDocument[] = [];
  if (queryParams.assetIds !== undefined) {
    if (typeof queryParams.assetIds !== "string") {
      throw new SearchError(400, "Invalid assetIds parameter format.");
    }
    const rawIds = queryParams.assetIds
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (rawIds.length === 0) {
      throw new SearchError(400, "assetIds parameter was provided but contained no valid IDs.");
    }

    const uniqueIds = Array.from(new Set(rawIds));
    for (const id of uniqueIds) {
      if (!ObjectId.isValid(id)) {
        throw new SearchError(400, `Invalid asset ID format: ${id}`);
      }
    }

    const foundAssets = await getMediaCollection()
      .find({
        projectId,
        _id: { $in: uniqueIds.map((id) => new ObjectId(id)) }
      })
      .toArray();

    const foundIdSet = new Set(foundAssets.map((a) => a._id.toHexString()));
    for (const requestedId of uniqueIds) {
      if (!foundIdSet.has(requestedId)) {
        throw new SearchError(400, `Asset not found in this project: ${requestedId}`);
      }
    }
    targetAssets = foundAssets;
  } else {
    targetAssets = await getMediaCollection()
      .find({ projectId })
      .limit(MAX_ELIGIBLE_ASSETS_PER_REQUEST)
      .toArray();
  }

  if (targetAssets.length === 0) {
    throw new SearchError(400, "No eligible media assets found in this project.");
  }

  // Retrieve transcription documents for target assets
  const assetIdStrings = targetAssets.map((a) => a._id.toHexString());
  const transcriptionDocs = await getTranscriptionCollection()
    .find({
      projectId,
      assetId: { $in: assetIdStrings }
    })
    .toArray();

  const docMap = new Map<string, TranscriptionDocument>();
  for (const doc of transcriptionDocs) {
    docMap.set(doc.assetId, doc);
  }

  const unsearchableAssets: UnsearchableAssetInfo[] = [];
  const eligibleForSearch: MediaAssetDocument[] = [];
  let hasProcessing = false;

  for (const asset of targetAssets) {
    const aId = asset._id.toHexString();
    const doc = docMap.get(aId);

    if (!doc) {
      unsearchableAssets.push({
        assetId: aId,
        assetName: asset.originalName,
        reason: "Transcription analysis has not been performed for this media asset."
      });
    } else if (doc.status === "queued" || doc.status === "processing") {
      hasProcessing = true;
      unsearchableAssets.push({
        assetId: aId,
        assetName: asset.originalName,
        reason: "Transcription analysis is currently in progress for this media asset."
      });
    } else if (doc.status === "failed") {
      unsearchableAssets.push({
        assetId: aId,
        assetName: asset.originalName,
        reason: "Transcription analysis failed for this media asset."
      });
    } else if (doc.status === "canceled") {
      unsearchableAssets.push({
        assetId: aId,
        assetName: asset.originalName,
        reason: "Transcription analysis was canceled for this media asset."
      });
    } else if (doc.status === "completed") {
      eligibleForSearch.push(asset);
    } else {
      unsearchableAssets.push({
        assetId: aId,
        assetName: asset.originalName,
        reason: `Transcription analysis is not ready (status: ${doc.status}).`
      });
    }
  }

  if (eligibleForSearch.length === 0) {
    if (hasProcessing) {
      throw new SearchError(409, "Transcription analysis is currently in progress for the specified media assets.");
    }
    throw new SearchError(400, "No eligible media assets with completed transcription were found in this project.");
  }

  // -------------------------------------------------------------
  // Concurrency Pool with Atomic Byte Reservation
  // -------------------------------------------------------------
  let cumulativeReservedBytes = 0;
  let budgetExhausted = false;
  let matchBudgetExhausted = false;
  let searchedAssetCount = 0;
  const allMatches: SpeechSearchMatch[] = [];

  let nextIndex = 0;
  const activeWorkerPromises: Promise<void>[] = [];

  const runWorker = async (): Promise<void> => {
    while (nextIndex < eligibleForSearch.length) {
      if (budgetExhausted || matchBudgetExhausted) {
        break;
      }

      const currentIndex = nextIndex++;
      const currentAsset = eligibleForSearch[currentIndex];
      const aId = currentAsset._id.toHexString();
      const transcriptPath = resolveAssetTranscriptPath(projectId, aId);

      // Check file existence
      if (!fs.existsSync(transcriptPath)) {
        unsearchableAssets.push({
          assetId: aId,
          assetName: currentAsset.originalName,
          reason: "Transcript artifact is unavailable on server."
        });
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(transcriptPath);
      } catch {
        unsearchableAssets.push({
          assetId: aId,
          assetName: currentAsset.originalName,
          reason: "Transcript artifact could not be accessed."
        });
        continue;
      }

      // Check individual artifact limit (20 MB)
      if (stat.size > MAX_INDIVIDUAL_ARTIFACT_BYTES) {
        unsearchableAssets.push({
          assetId: aId,
          assetName: currentAsset.originalName,
          reason: `Transcript artifact exceeds individual limit of ${MAX_INDIVIDUAL_ARTIFACT_BYTES / (1024 * 1024)}MB.`
        });
        continue;
      }

      // Atomic reservation of raw artifact bytes
      if (cumulativeReservedBytes + stat.size > MAX_AGGREGATE_ARTIFACT_READ_BYTES) {
        budgetExhausted = true;
        break;
      }
      cumulativeReservedBytes += stat.size;

      // Read and search artifact
      let rawContent: string | undefined;
      let transcriptData: TranscriptData | undefined;
      let flattenedWords: FlattenedWord[] | undefined;

      try {
        rawContent = await fs.promises.readFile(transcriptPath, "utf-8");
        transcriptData = JSON.parse(rawContent) as TranscriptData;
        flattenedWords = extractFlattenedWords(transcriptData);

        const assetMatches = searchWordsInTranscript(
          flattenedWords,
          queryTokens,
          aId,
          currentAsset.originalName,
          timeWindow,
          allMatches.length
        );

        for (const m of assetMatches) {
          allMatches.push(m);
        }
        searchedAssetCount++;
      } catch (err) {
        if (err instanceof SearchError && err.message.includes("limit of 5000 matches")) {
          matchBudgetExhausted = true;
          break;
        }
        unsearchableAssets.push({
          assetId: aId,
          assetName: currentAsset.originalName,
          reason: "Failed to read or parse transcript artifact."
        });
      } finally {
        // Explicit dereference to allow V8 garbage collection
        rawContent = undefined;
        transcriptData = undefined;
        flattenedWords = undefined;
      }
    }
  };

  // Launch at most MAX_CONCURRENT_ARTIFACT_READS concurrent workers
  const concurrency = Math.min(MAX_CONCURRENT_ARTIFACT_READS, eligibleForSearch.length);
  for (let i = 0; i < concurrency; i++) {
    activeWorkerPromises.push(runWorker());
  }

  // Await all active workers to safely settle
  await Promise.allSettled(activeWorkerPromises);

  if (budgetExhausted) {
    throw new SearchError(
      400,
      `Project search exceeded aggregate artifact size limit of ${MAX_AGGREGATE_ARTIFACT_READ_BYTES / (1024 * 1024)}MB. Please narrow the queried assets using assetIds.`
    );
  }

  if (matchBudgetExhausted || allMatches.length > MAX_MATCH_BUDGET) {
    throw new SearchError(
      400,
      `Query matched too many results (exceeded limit of ${MAX_MATCH_BUDGET} matches). Please refine your search query or specify a narrower time window.`
    );
  }

  // Deterministic 3-level sort: (start ASC, assetId ASC, wordIndex ASC)
  allMatches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.assetId !== b.assetId) return a.assetId.localeCompare(b.assetId);
    return a.id.localeCompare(b.id);
  });

  const searchComplete = unsearchableAssets.length === 0;

  return {
    query: String(queryParams.q),
    projectId,
    searchedAssetCount,
    unsearchableAssetCount: unsearchableAssets.length,
    searchComplete,
    unsearchableAssets,
    totalMatches: allMatches.length,
    limit,
    offset,
    matches: allMatches.slice(offset, offset + limit)
  };
}

