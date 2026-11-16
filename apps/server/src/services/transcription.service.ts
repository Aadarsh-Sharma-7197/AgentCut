import { Collection, ObjectId } from "mongodb";
import fs from "fs";
import { getDB } from "../config/db.js";
import {
  resolveAssetAnalysisAudioPath,
  resolveAssetTranscriptPath,
  resolveAssetTranscriptTempPath
} from "../config/storage.js";
import {
  TranscriptionDocument,
  toTranscriptionDTO
} from "../models/transcription.model.js";
import { getMediaAssetById } from "./media.service.js";
import { getProjectById } from "./project.service.js";
import { getAudioExtraction } from "./audio-extraction.service.js";
import {
  executeWorkerTranscription,
  WorkerTranscribeResult
} from "./transcription-worker.service.js";
import type {
  TranscriptionArtifact,
  TranscriptionParameters,
  TranscriptionWithTranscript,
  TranscriptData
} from "@agentcut/shared";

const COLLECTION_NAME = "transcriptions";

export const ALLOWED_MODELS = ["small", "base"] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];
export const DEFAULT_MODEL: AllowedModel = "small";

interface ActiveJob {
  id: string;
  projectId: string;
  assetId: string;
  key: string;
  canceled: boolean;
  promise: Promise<TranscriptionArtifact>;
}

// In-memory active transcription map for concurrency deduplication
const activeJobs = new Map<string, ActiveJob>();

// Serialized queue lock so only one transcription runs at a time
let executionQueuePromise: Promise<void> = Promise.resolve();

function getCollection(): Collection<TranscriptionDocument> {
  return getDB().collection<TranscriptionDocument>(COLLECTION_NAME);
}

export async function initTranscriptionIndexes(): Promise<void> {
  try {
    const col = getCollection();
    await col.createIndex({ projectId: 1, assetId: 1 });
    await col.createIndex({ projectId: 1 });
    await col.createIndex({ createdAt: -1 });
  } catch (err) {
    console.error("[TranscriptionService] Error creating indexes:", err);
  }
}

/**
 * Validates transcription parameters against allowlists.
 */
export function validateTranscriptionParameters(
  raw?: Partial<TranscriptionParameters>
): TranscriptionParameters {
  let modelName: AllowedModel = DEFAULT_MODEL;
  let languageHint: string | undefined = undefined;
  let device: "auto" | "cuda" | "cpu" = "auto";
  let computeType: string | undefined = undefined;

  if (raw?.modelName !== undefined) {
    if (!ALLOWED_MODELS.includes(raw.modelName as any)) {
      throw new Error(`Invalid modelName '${raw.modelName}'. Allowed models: ${ALLOWED_MODELS.join(", ")}`);
    }
    modelName = raw.modelName as AllowedModel;
  }

  if (raw?.languageHint !== undefined && raw.languageHint !== null && raw.languageHint !== "") {
    const hint = String(raw.languageHint).trim().toLowerCase();
    if (!/^[a-z]{2,3}$/.test(hint)) {
      throw new Error(`Invalid languageHint '${raw.languageHint}'. Expected a valid 2 or 3-letter language code (e.g. 'en', 'hi').`);
    }
    languageHint = hint;
  }

  if (raw?.device !== undefined) {
    if (!["auto", "cuda", "cpu"].includes(raw.device)) {
      throw new Error(`Invalid device '${raw.device}'. Allowed devices: 'auto', 'cuda', 'cpu'.`);
    }
    device = raw.device;
  }

  if (raw?.computeType !== undefined && typeof raw.computeType === "string") {
    computeType = raw.computeType.trim();
  }

  const result: TranscriptionParameters = {
    modelName,
    device
  };
  if (languageHint) {
    result.languageHint = languageHint;
  }
  if (computeType) {
    result.computeType = computeType;
  }

  return result;
}

/**
 * Documented timestamp rounding tolerance in seconds (0.5s) to allow for minor
 * audio boundary precision discrepancies in Whisper model mel-frequency frame hops.
 */
export const TRANSCRIPTION_TIMESTAMP_TOLERANCE_SECONDS = 0.5;

/**
 * Validates that segments in a transcript are well-formed, ordered, and have finite, non-negative timestamps.
 */
export function validateTranscriptData(data: any, audioDuration: number): TranscriptData {
  if (!data || typeof data !== "object") {
    throw new Error("Transcript artifact is not a valid JSON object.");
  }

  if (!Array.isArray(data.segments)) {
    throw new Error("Transcript artifact missing 'segments' array.");
  }

  const durationLimit = audioDuration > 0
    ? audioDuration + TRANSCRIPTION_TIMESTAMP_TOLERANCE_SECONDS
    : Infinity;

  for (let i = 0; i < data.segments.length; i++) {
    const seg = data.segments[i];
    if (!seg || typeof seg !== "object") {
      throw new Error(`Segment ${i} is not a valid object.`);
    }

    if (typeof seg.start !== "number" || !Number.isFinite(seg.start) || seg.start < 0) {
      throw new Error(`Segment ${i} has invalid start timestamp: ${seg.start}`);
    }

    if (typeof seg.end !== "number" || !Number.isFinite(seg.end) || seg.end <= seg.start) {
      throw new Error(`Segment ${i} has invalid end timestamp: ${seg.end} (must be finite and > start ${seg.start})`);
    }

    if (seg.start > durationLimit) {
      throw new Error(`Segment ${i} start (${seg.start}s) exceeds audio duration (${audioDuration}s).`);
    }

    if (seg.end > durationLimit) {
      throw new Error(`Segment ${i} end (${seg.end}s) exceeds audio duration limit (${durationLimit}s).`);
    }

    if (typeof seg.text !== "string") {
      throw new Error(`Segment ${i} is missing text property.`);
    }

    // Chronological ordering
    if (i > 0 && seg.start < data.segments[i - 1].start) {
      throw new Error(
        `Segment ${i} start (${seg.start}s) is not chronologically ordered after segment ${i - 1} start (${data.segments[i - 1].start}s).`
      );
    }

    // Word timestamp validation
    if (Array.isArray(seg.words)) {
      for (let w = 0; w < seg.words.length; w++) {
        const word = seg.words[w];
        if (!word || typeof word !== "object") {
          throw new Error(`Segment ${i} word ${w} is not a valid object.`);
        }
        if (typeof word.word !== "string") {
          throw new Error(`Segment ${i} word ${w} is missing text.`);
        }
        if (typeof word.start !== "number" || !Number.isFinite(word.start) || word.start < 0) {
          throw new Error(`Segment ${i} word ${w} has invalid start timestamp: ${word.start}`);
        }
        if (typeof word.end !== "number" || !Number.isFinite(word.end) || word.end < word.start) {
          throw new Error(`Segment ${i} word ${w} has invalid end timestamp: ${word.end}`);
        }
        if (
          word.start < seg.start - TRANSCRIPTION_TIMESTAMP_TOLERANCE_SECONDS ||
          word.end > seg.end + TRANSCRIPTION_TIMESTAMP_TOLERANCE_SECONDS
        ) {
          throw new Error(
            `Segment ${i} word ${w} [${word.start}s -> ${word.end}s] exceeds parent segment boundaries [${seg.start}s -> ${seg.end}s].`
          );
        }
      }
    }
  }

  return {
    language: String(data.language || "unknown"),
    languageProbability: typeof data.language_probability === "number" ? data.language_probability : undefined,
    duration: typeof data.duration === "number" ? data.duration : audioDuration,
    segments: data.segments,
    text: String(data.text || "")
  };
}

/**
 * Requests transcription for an asset.
 * Enforces:
 * - Prerequisite check: asset audio must be extracted first.
 * - Concurrency control & deduplication.
 * - Cache reuse for identical parameters.
 * - Reanalysis when parameters change.
 * - Serialized execution.
 * - Atomic persistence of transcript.json.
 */
export async function requestTranscription(
  projectId: string,
  assetId: string,
  rawParams?: Partial<TranscriptionParameters>
): Promise<TranscriptionArtifact> {
  const params = validateTranscriptionParameters(rawParams);

  // 1. Verify project exists
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' not found.`);
  }

  // 2. Verify media asset exists and belongs to this project
  const mediaAssetData = await getMediaAssetById(projectId, assetId);
  if (!mediaAssetData) {
    throw new Error(`Media asset '${assetId}' not found in project '${projectId}'.`);
  }

  // 3. Verify that audio extraction has been completed for this asset
  const audioExtraction = await getAudioExtraction(projectId, assetId);
  if (!audioExtraction || audioExtraction.status !== "completed") {
    throw new Error(
      "Audio extraction has not been performed for this media asset. Please extract audio before requesting transcription."
    );
  }

  // 4. Verify physical audio.wav exists on disk
  const audioWavPath = resolveAssetAnalysisAudioPath(projectId, assetId);
  if (!fs.existsSync(audioWavPath)) {
    throw new Error(
      "Audio extraction artifact (audio.wav) was not found on disk. Please extract audio before requesting transcription."
    );
  }

  const audioDuration = audioExtraction.audioProperties?.duration || 0;

  // 5. Concurrency control: if identical job is active, return in-flight promise
  const activeKey = `${assetId}:${params.modelName}:${params.languageHint || "auto"}:${params.device || "auto"}`;
  const existingActive = activeJobs.get(activeKey);
  if (existingActive) {
    return existingActive.promise;
  }

  // 6. Check existing completed transcription in MongoDB for cache reuse
  const col = getCollection();
  const existingDoc = await col.findOne({ projectId, assetId });

  const existingLang = existingDoc?.parameters?.languageHint || undefined;
  const targetLang = params.languageHint || undefined;

  if (
    existingDoc &&
    existingDoc.status === "completed" &&
    existingDoc.parameters?.modelName === params.modelName &&
    existingLang === targetLang
  ) {
    const finalTranscriptPath = resolveAssetTranscriptPath(projectId, assetId);
    if (fs.existsSync(finalTranscriptPath)) {
      return toTranscriptionDTO(existingDoc);
    }
  }

  // 7. Initialize or update MongoDB document to 'queued'
  const now = new Date();
  const initialDoc = await col.findOneAndUpdate(
    { projectId, assetId },
    {
      $set: {
        projectId,
        assetId,
        status: "queued",
        parameters: params,
        error: undefined,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true, returnDocument: "after" }
  );

  const docId = initialDoc?._id ? initialDoc._id.toHexString() : new ObjectId().toHexString();

  // 8. Create execution closure serialized through queue
  const activeJob: ActiveJob = {
    id: docId,
    projectId,
    assetId,
    key: activeKey,
    canceled: false,
    promise: Promise.resolve() as unknown as Promise<TranscriptionArtifact>
  };
  activeJobs.set(activeKey, activeJob);

  const executeTranscription = async (): Promise<TranscriptionArtifact> => {
    // Wait for previous queue tasks to finish (serialization lock)
    const prevQueue = executionQueuePromise;
    let releaseQueue: () => void;
    executionQueuePromise = new Promise((resolve) => {
      releaseQueue = resolve;
    });

    try {
      await prevQueue;
    } catch {}

    const tempTranscriptPath = resolveAssetTranscriptTempPath(projectId, assetId, docId);
    const finalTranscriptPath = resolveAssetTranscriptPath(projectId, assetId);

    try {
      if (activeJob.canceled) {
        throw new Error("Transcription was canceled by user.");
      }

      // Update DB to 'processing'
      await col.updateOne(
        { projectId, assetId },
        { $set: { status: "processing", updatedAt: new Date() } }
      );

      // Execute worker transcription
      const workerRes: WorkerTranscribeResult = await executeWorkerTranscription({
        audioPath: audioWavPath,
        modelName: params.modelName,
        languageHint: params.languageHint,
        device: params.device,
        computeType: params.computeType,
        wordTimestamps: true
      });

      if (!workerRes.success || workerRes.error) {
        throw new Error(workerRes.error || "Transcription worker failed without error details.");
      }

      if (activeJob.canceled) {
        throw new Error("Transcription was canceled by user.");
      }

      // Prepare transcript JSON object
      const rawTranscript = {
        language: workerRes.language,
        language_probability: workerRes.language_probability,
        duration: workerRes.duration || audioDuration,
        segment_count: workerRes.segment_count || workerRes.segments?.length || 0,
        segments: workerRes.segments || [],
        text: workerRes.text || ""
      };

      const validatedTranscript = validateTranscriptData(rawTranscript, audioDuration);

      // Atomic write: write to temp file then rename
      fs.writeFileSync(tempTranscriptPath, JSON.stringify(validatedTranscript, null, 2), "utf-8");
      fs.renameSync(tempTranscriptPath, finalTranscriptPath);

      const completedAt = new Date();
      const updatedDoc = await col.findOneAndUpdate(
        { projectId, assetId, _id: new ObjectId(docId), status: { $ne: "canceled" } },
        {
          $set: {
            status: "completed",
            parameters: params,
            detectedLanguage: validatedTranscript.language,
            languageProbability: validatedTranscript.languageProbability,
            audioDuration: validatedTranscript.duration,
            segmentCount: validatedTranscript.segments.length,
            executionDevice: workerRes.execution_device || "cpu",
            computeType: workerRes.compute_type || "int8",
            engineMetadata: {
              engine: "faster-whisper",
              version: "1.1.1"
            },
            artifactPath: finalTranscriptPath,
            completedAt,
            error: undefined,
            updatedAt: completedAt
          }
        },
        { returnDocument: "after" }
      );

      if (!updatedDoc) {
        throw new Error(
          activeJob.canceled
            ? "Transcription was canceled by user."
            : "Failed to update transcription record: job was canceled or superseded."
        );
      }

      return toTranscriptionDTO(updatedDoc);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Transcription failed.";
      const isCanceled = activeJob.canceled || errorMsg.includes("canceled");

      try {
        if (fs.existsSync(tempTranscriptPath)) {
          fs.unlinkSync(tempTranscriptPath);
        }
      } catch {}

      const failStatus = isCanceled ? "canceled" : "failed";
      await col.updateOne(
        { projectId, assetId },
        {
          $set: {
            status: failStatus,
            error: errorMsg,
            updatedAt: new Date()
          }
        }
      );

      throw new Error(errorMsg);
    } finally {
      activeJobs.delete(activeKey);
      releaseQueue!();
    }
  };

  const jobPromise = executeTranscription();
  activeJob.promise = jobPromise;
  return jobPromise;
}

/**
 * Retrieves transcription metadata for a media asset.
 */
export async function getTranscription(
  projectId: string,
  assetId: string,
  transcriptionId?: string
): Promise<TranscriptionArtifact | null> {
  const col = getCollection();
  const query: any = { projectId, assetId };
  if (transcriptionId && ObjectId.isValid(transcriptionId)) {
    query._id = new ObjectId(transcriptionId);
  }

  const doc = await col.findOne(query);
  if (!doc) {
    return null;
  }

  return toTranscriptionDTO(doc);
}

/**
 * Retrieves transcription metadata and reads the full transcript JSON artifact from disk.
 */
export async function getTranscriptionWithTranscript(
  projectId: string,
  assetId: string,
  transcriptionId?: string
): Promise<TranscriptionWithTranscript | null> {
  const meta = await getTranscription(projectId, assetId, transcriptionId);
  if (!meta) {
    return null;
  }

  let transcript: TranscriptData | undefined = undefined;
  if (meta.status === "completed") {
    try {
      const transcriptPath = resolveAssetTranscriptPath(projectId, assetId);
      if (fs.existsSync(transcriptPath)) {
        const rawContent = fs.readFileSync(transcriptPath, "utf-8");
        transcript = JSON.parse(rawContent);
      }
    } catch (err) {
      console.warn(`[TranscriptionService] Failed to read transcript artifact for asset ${assetId}:`, err);
    }
  }

  return {
    ...meta,
    transcript
  };
}

/**
 * Checks whether transcription is currently active for an asset.
 */
export function isTranscriptionActive(assetId: string): boolean {
  for (const job of activeJobs.values()) {
    if (job.assetId === assetId && !job.canceled) {
      return true;
    }
  }
  return false;
}

/**
 * Cancels an active transcription job.
 */
export async function cancelTranscription(
  projectId: string,
  assetId: string,
  transcriptionId?: string
): Promise<boolean> {
  let canceled = false;

  for (const [key, job] of activeJobs.entries()) {
    if (job.assetId === assetId && job.projectId === projectId) {
      if (!transcriptionId || job.id === transcriptionId) {
        job.canceled = true;
        canceled = true;
      }
    }
  }

  if (canceled) {
    const col = getCollection();
    await col.updateOne(
      { projectId, assetId },
      { $set: { status: "canceled", error: "Transcription canceled by user.", updatedAt: new Date() } }
    );
  }

  return canceled;
}

/**
 * Deletes all transcription metadata records associated with a project.
 * POLICY ENFORCEMENT: Deletion removes ONLY MongoDB metadata records.
 * It NEVER deletes original media files, exports, or analysis/transcript files.
 */
export async function deleteTranscriptionsByProject(projectId: string): Promise<number> {
  const col = getCollection();
  const result = await col.deleteMany({ projectId });
  return result.deletedCount;
}
