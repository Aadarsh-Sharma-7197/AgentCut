import { Collection, ObjectId } from "mongodb";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import { getDB } from "../config/db.js";
import { resolveAssetAnalysisAudioPath } from "../config/storage.js";
import {
  SilenceDetectionDocument,
  toSilenceDetectionDTO
} from "../models/silence-detection.model.js";
import { getMediaAssetById } from "./media.service.js";
import { getProjectById } from "./project.service.js";
import { getAudioExtraction } from "./audio-extraction.service.js";
import { getFFmpegPath, checkFFmpegAvailable, validateFFmpegSafety } from "../utils/ffmpeg.js";
import { inspectAudioFile } from "../utils/ffprobe.js";
import type {
  SilenceDetectionArtifact,
  SilenceDetectionParameters,
  SilenceInterval
} from "@agentcut/shared";

const COLLECTION_NAME = "silence_detections";

export const DEFAULT_NOISE_THRESHOLD_DB = -35;
export const DEFAULT_MIN_DURATION_SECONDS = 0.5;

interface ActiveSilenceDetection {
  assetId: string;
  projectId: string;
  key: string;
  process?: ChildProcess;
  promise: Promise<SilenceDetectionArtifact>;
}

// In-memory active detection map for concurrency deduplication
const activeDetections = new Map<string, ActiveSilenceDetection>();

function getCollection(): Collection<SilenceDetectionDocument> {
  return getDB().collection<SilenceDetectionDocument>(COLLECTION_NAME);
}

export async function initSilenceDetectionIndexes(): Promise<void> {
  try {
    const col = getCollection();
    await col.createIndex({ projectId: 1, assetId: 1 });
    await col.createIndex({ projectId: 1 });
    await col.createIndex({ createdAt: -1 });
  } catch (err) {
    console.error("[SilenceDetectionService] Error creating indexes:", err);
  }
}

/**
 * Validates and normalizes silence detection parameters with sensible boundaries.
 * - noiseThresholdDb: between -90 dB and 0 dB (default: -35 dB)
 * - minDurationSeconds: between 0.1 s and 3600 s (default: 0.5 s)
 */
export function validateSilenceDetectionParameters(
  params?: Partial<SilenceDetectionParameters>
): SilenceDetectionParameters {
  let noiseThresholdDb = DEFAULT_NOISE_THRESHOLD_DB;
  let minDurationSeconds = DEFAULT_MIN_DURATION_SECONDS;

  if (params?.noiseThresholdDb !== undefined) {
    const val = Number(params.noiseThresholdDb);
    if (isNaN(val) || val < -90 || val > 0) {
      throw new Error("noiseThresholdDb must be a valid number between -90 dB and 0 dB.");
    }
    noiseThresholdDb = Math.round(val * 10) / 10;
  }

  if (params?.minDurationSeconds !== undefined) {
    const val = Number(params.minDurationSeconds);
    if (isNaN(val) || val < 0.1 || val > 3600) {
      throw new Error("minDurationSeconds must be a valid number between 0.1 and 3600 seconds.");
    }
    minDurationSeconds = Math.round(val * 100) / 100;
  }

  return { noiseThresholdDb, minDurationSeconds };
}

/**
 * Parses FFmpeg silencedetect diagnostic stderr output into sorted, non-overlapping intervals.
 * Handles:
 * - Silence at timestamp 0
 * - Silence extending to the end of the file (trailing unclosed silence_start)
 * - Clamping intervals within [0, audioDuration]
 * - Filtering out intervals shorter than minDurationSeconds
 */
export function parseSilenceDetectOutput(
  stderr: string,
  audioDuration: number,
  minDurationSeconds: number
): SilenceInterval[] {
  const lines = stderr.split(/\r?\n/);
  const rawIntervals: SilenceInterval[] = [];

  let currentStart: number | null = null;

  for (const line of lines) {
    // Check for silence_start: e.g. [Parsed_silencedetect_0 @ ...] silence_start: 1.000
    const startMatch = line.match(/silence_start:\s*([0-9.-]+)/);
    if (startMatch) {
      const parsedStart = parseFloat(startMatch[1]);
      if (!isNaN(parsedStart)) {
        currentStart = Math.max(0, parsedStart);
      }
    }

    // Check for silence_end: e.g. [Parsed_silencedetect_0 @ ...] silence_end: 2.000062 | silence_duration: 1.000063
    const endMatch = line.match(/silence_end:\s*([0-9.-]+)/);
    if (endMatch && currentStart !== null) {
      const parsedEnd = parseFloat(endMatch[1]);
      if (!isNaN(parsedEnd)) {
        const clampedStart = Math.max(0, Math.min(currentStart, audioDuration));
        const clampedEnd = Math.max(clampedStart, Math.min(parsedEnd, audioDuration));
        const duration = Math.round((clampedEnd - clampedStart) * 1000) / 1000;

        if (duration >= minDurationSeconds) {
          rawIntervals.push({
            start: Math.round(clampedStart * 1000) / 1000,
            end: Math.round(clampedEnd * 1000) / 1000,
            duration
          });
        }
      }
      currentStart = null;
    }
  }

  // Handle trailing silence that extends to the end of the audio file
  if (currentStart !== null && currentStart < audioDuration) {
    const clampedStart = Math.max(0, currentStart);
    const clampedEnd = audioDuration;
    const duration = Math.round((clampedEnd - clampedStart) * 1000) / 1000;

    if (duration >= minDurationSeconds) {
      rawIntervals.push({
        start: Math.round(clampedStart * 1000) / 1000,
        end: Math.round(clampedEnd * 1000) / 1000,
        duration
      });
    }
  }

  // Sort intervals chronologically
  rawIntervals.sort((a, b) => a.start - b.start);

  // Merge any adjacent or overlapping intervals to prevent duplicates
  const merged: SilenceInterval[] = [];
  for (const interval of rawIntervals) {
    if (merged.length === 0) {
      merged.push(interval);
    } else {
      const prev = merged[merged.length - 1];
      if (interval.start <= prev.end) {
        prev.end = Math.max(prev.end, interval.end);
        prev.duration = Math.round((prev.end - prev.start) * 1000) / 1000;
      } else {
        merged.push(interval);
      }
    }
  }

  return merged;
}

/**
 * Retrieves the current silence detection metadata for an asset.
 */
export async function getSilenceDetection(
  projectId: string,
  assetId: string
): Promise<SilenceDetectionArtifact | null> {
  if (!ObjectId.isValid(assetId)) {
    return null;
  }

  const col = getCollection();
  const doc = await col.findOne({ projectId, assetId });
  if (!doc) {
    return null;
  }

  return toSilenceDetectionDTO(doc);
}

/**
 * Executes silence detection using the existing extracted audio.wav artifact.
 *
 * Guarantees:
 * - Requires existing audio extraction: if audio is not extracted, throws clear error.
 * - Concurrency control: duplicate requests with same parameters share in-flight promise.
 * - Idempotency & Caching: unchanged parameters return existing completed artifact.
 * - Reanalysis: if parameters change, runs fresh analysis and updates document.
 * - Clamping and safe timestamp bounds.
 * - Safe FFmpeg execution (spawn, shell: false, validateFFmpegSafety).
 */
export async function detectSilence(
  projectId: string,
  assetId: string,
  rawParams?: Partial<SilenceDetectionParameters>
): Promise<SilenceDetectionArtifact> {
  const params = validateSilenceDetectionParameters(rawParams);

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
      "Audio extraction has not been performed for this media asset. Please extract audio before detecting silence."
    );
  }

  // 4. Verify physical audio.wav exists on disk
  const audioWavPath = resolveAssetAnalysisAudioPath(projectId, assetId);
  if (!fs.existsSync(audioWavPath)) {
    throw new Error(
      "Audio extraction artifact (audio.wav) was not found on disk. Please extract audio before detecting silence."
    );
  }

  // 5. Check concurrency: if identical detection is active, return in-flight promise
  const activeKey = `${assetId}:${params.noiseThresholdDb}:${params.minDurationSeconds}`;
  const existingActive = activeDetections.get(activeKey);
  if (existingActive) {
    return existingActive.promise;
  }

  // 6. Check existing completed detection in database for cache reuse
  const col = getCollection();
  const existingDoc = await col.findOne({ projectId, assetId });

  if (
    existingDoc &&
    existingDoc.status === "completed" &&
    existingDoc.parameters.noiseThresholdDb === params.noiseThresholdDb &&
    existingDoc.parameters.minDurationSeconds === params.minDurationSeconds
  ) {
    return toSilenceDetectionDTO(existingDoc);
  }

  // 7. Inspect audio file with FFprobe to verify duration
  const audioInfo = await inspectAudioFile(audioWavPath);
  const audioDuration = audioInfo.duration;

  // 8. Verify FFmpeg availability
  const ffmpegOk = await checkFFmpegAvailable();
  if (!ffmpegOk) {
    const errorMsg = "FFmpeg executable not found or not runnable. Ensure FFmpeg is installed.";
    const now = new Date();
    await col.updateOne(
      { projectId, assetId },
      {
        $set: {
          projectId,
          assetId,
          status: "failed",
          parameters: params,
          error: errorMsg,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
    throw new Error(errorMsg);
  }

  // 9. Update DB status to 'detecting'
  const now = new Date();
  await col.updateOne(
    { projectId, assetId },
    {
      $set: {
        projectId,
        assetId,
        status: "detecting",
        parameters: params,
        error: undefined,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );

  // 10. Construct FFmpeg command arguments
  const filterStr = `silencedetect=noise=${params.noiseThresholdDb}dB:d=${params.minDurationSeconds}`;
  const ffmpegArgs = [
    "-hide_banner",
    "-vn",
    "-i",
    audioWavPath,
    "-af",
    filterStr,
    "-f",
    "null",
    "-"
  ];

  validateFFmpegSafety(ffmpegArgs);

  const ffmpegBinary = getFFmpegPath();

  const runDetection = (): Promise<SilenceDetectionArtifact> => {
    return new Promise<SilenceDetectionArtifact>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(ffmpegBinary, ffmpegArgs, { shell: false });
      } catch (spawnErr) {
        activeDetections.delete(activeKey);
        const errMsg = `Failed to spawn FFmpeg process: ${spawnErr instanceof Error ? spawnErr.message : "Unknown error"}`;
        col.updateOne(
          { projectId, assetId },
          { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
        ).catch(() => {});
        return reject(new Error(errMsg));
      }

      const activeEntry = activeDetections.get(activeKey);
      if (activeEntry) {
        activeEntry.process = proc;
      }

      let stderrData = "";

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString();
      });

      proc.on("error", async (err) => {
        activeDetections.delete(activeKey);
        const errMsg = `FFmpeg process error: ${err.message}`;
        await col.updateOne(
          { projectId, assetId },
          { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
        );
        reject(new Error(errMsg));
      });

      proc.on("close", async (code) => {
        activeDetections.delete(activeKey);

        if (code !== 0) {
          const errMsg = `FFmpeg exited with code ${code}. ${stderrData.trim() || "Silence detection failed."}`;
          await col.updateOne(
            { projectId, assetId },
            { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
          );
          return reject(new Error(errMsg));
        }

        try {
          const intervals = parseSilenceDetectOutput(
            stderrData,
            audioDuration,
            params.minDurationSeconds
          );
          const totalSilenceDuration = Math.round(
            intervals.reduce((sum, i) => sum + i.duration, 0) * 1000
          ) / 1000;

          const completionTime = new Date();
          const updatedDoc = await col.findOneAndUpdate(
            { projectId, assetId },
            {
              $set: {
                status: "completed",
                parameters: params,
                intervals,
                totalSilenceDuration,
                audioDuration,
                completedAt: completionTime,
                error: undefined,
                updatedAt: completionTime
              }
            },
            { returnDocument: "after" }
          );

          if (!updatedDoc) {
            throw new Error("Failed to retrieve updated silence detection record from database.");
          }

          resolve(toSilenceDetectionDTO(updatedDoc));
        } catch (parseErr) {
          const errMsg = `Failed to process silence detection output: ${parseErr instanceof Error ? parseErr.message : "Unknown error"}`;
          await col.updateOne(
            { projectId, assetId },
            { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
          );
          reject(new Error(errMsg));
        }
      });
    });
  };

  const activeEntry: ActiveSilenceDetection = {
    assetId,
    projectId,
    key: activeKey,
    promise: Promise.resolve() as unknown as Promise<SilenceDetectionArtifact>
  };
  activeDetections.set(activeKey, activeEntry);

  const detectionPromise = runDetection();
  activeEntry.promise = detectionPromise;

  return detectionPromise;
}

/**
 * Cancels an active silence detection for an asset.
 */
export function cancelActiveSilenceDetection(assetId: string): boolean {
  let canceled = false;
  for (const [key, active] of activeDetections.entries()) {
    if (active.assetId === assetId) {
      try {
        if (active.process && !active.process.killed) {
          active.process.kill("SIGKILL");
        }
      } catch {}
      activeDetections.delete(key);
      canceled = true;
    }
  }
  return canceled;
}

/**
 * Checks whether silence detection is currently active for an asset.
 */
export function isSilenceDetectionActive(assetId: string): boolean {
  for (const active of activeDetections.values()) {
    if (active.assetId === assetId) return true;
  }
  return false;
}

/**
 * Deletes all silence detection metadata records associated with a project.
 * POLICY ENFORCEMENT: Deletion removes ONLY MongoDB metadata records.
 * It NEVER deletes original media files, exports, or analysis files.
 */
export async function deleteSilenceDetectionsByProject(projectId: string): Promise<number> {
  const col = getCollection();
  const result = await col.deleteMany({ projectId });
  return result.deletedCount;
}

/**
 * Shuts down all active silence detection processes.
 */
export function registerSilenceDetectionShutdownHooks(): void {
  const cleanup = () => {
    for (const [key, active] of activeDetections.entries()) {
      try {
        if (active.process && !active.process.killed) {
          active.process.kill("SIGKILL");
        }
      } catch {}
    }
    activeDetections.clear();
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
}
