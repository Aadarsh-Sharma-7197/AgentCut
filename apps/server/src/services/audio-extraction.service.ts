import { Collection, ObjectId } from "mongodb";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import { getDB } from "../config/db.js";
import {
  getAssetAnalysisDir,
  resolveAssetAnalysisAudioPath,
  resolveAssetAnalysisTempAudioPath,
  resolveStoredFilePath
} from "../config/storage.js";
import {
  AudioExtractionDocument,
  toAudioExtractionDTO
} from "../models/audio-extraction.model.js";
import { getMediaAssetById } from "./media.service.js";
import { getProjectById } from "./project.service.js";
import { getFFmpegPath, checkFFmpegAvailable, validateFFmpegSafety } from "../utils/ffmpeg.js";
import { inspectAudioFile, hasAudioStream } from "../utils/ffprobe.js";
import type { AudioExtractionArtifact } from "@agentcut/shared";

const COLLECTION_NAME = "audio_extractions";

interface ActiveExtraction {
  assetId: string;
  projectId: string;
  process?: ChildProcess;
  tempPath: string;
  promise: Promise<AudioExtractionArtifact>;
}

// In-memory active extractions map for concurrency and deduplication
const activeExtractions = new Map<string, ActiveExtraction>();

function getCollection(): Collection<AudioExtractionDocument> {
  return getDB().collection<AudioExtractionDocument>(COLLECTION_NAME);
}

export async function initAudioExtractionIndexes(): Promise<void> {
  try {
    const col = getCollection();
    await col.createIndex({ projectId: 1, assetId: 1 }, { unique: true });
    await col.createIndex({ projectId: 1 });
    await col.createIndex({ createdAt: -1 });
  } catch (err) {
    console.error("[AudioExtractionService] Error creating indexes:", err);
  }
}

/**
 * Retrieves existing audio extraction metadata for an asset within a project.
 * Validates ownership and never exposes filesystem paths.
 */
export async function getAudioExtraction(
  projectId: string,
  assetId: string
): Promise<AudioExtractionArtifact | null> {
  if (!ObjectId.isValid(assetId)) {
    return null;
  }

  const col = getCollection();
  const doc = await col.findOne({ projectId, assetId });
  if (!doc) {
    return null;
  }

  return toAudioExtractionDTO(doc);
}

/**
 * Requests audio extraction for a video asset into:
 *   <project-directory>/analysis/<assetId>/audio.wav
 *
 * Output: WAV, pcm_s16le, mono, 16000 Hz.
 *
 * Guarantees:
 * - Deterministic, trusted server-side path resolution (no client paths).
 * - Safe FFmpeg invocation using spawn with discrete argument array and shell: false.
 * - Concurrency control: duplicate concurrent calls return the in-flight extraction.
 * - Idempotency: valid existing extractions are verified and reused without re-running FFmpeg.
 * - Explicit handling of videos with no audio streams (status: 'no_audio').
 * - Atomic promotion of temporary files: incomplete files are deleted on failure.
 * - FFprobe output validation before marking as completed.
 * - Original video source files remain strictly untouched (read-only input).
 */
export async function requestAudioExtraction(
  projectId: string,
  assetId: string
): Promise<AudioExtractionArtifact> {
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

  const { asset, storedFileName } = mediaAssetData;

  // 3. Concurrency check: If an extraction is currently in flight for this asset, reuse its promise
  const existingActive = activeExtractions.get(assetId);
  if (existingActive) {
    return existingActive.promise;
  }

  // 4. Check existing extraction in MongoDB
  const col = getCollection();
  const existingDoc = await col.findOne({ projectId, assetId });

  if (existingDoc) {
    // If completed, verify that audio.wav is actually present on disk and non-empty
    if (existingDoc.status === "completed") {
      try {
        const audioPath = resolveAssetAnalysisAudioPath(projectId, assetId);
        if (fs.existsSync(audioPath)) {
          const stats = fs.statSync(audioPath);
          if (stats.size > 0) {
            // Valid existing extraction cached — return without re-running FFmpeg
            return toAudioExtractionDTO(existingDoc);
          }
        }
      } catch {
        // Fall through to re-extract if filesystem check failed
      }
    } else if (existingDoc.status === "no_audio") {
      // Asset has no audio stream — return cached status
      return toAudioExtractionDTO(existingDoc);
    }
  }

  // 5. Check if source media file physically exists
  let sourceFilePath: string;
  try {
    sourceFilePath = resolveStoredFilePath(projectId, storedFileName);
  } catch (err) {
    throw new Error(`Failed to resolve source media path: ${err instanceof Error ? err.message : "Unknown error"}`);
  }

  if (!fs.existsSync(sourceFilePath)) {
    const errorMsg = "Source media file not found on disk.";
    const now = new Date();
    await col.updateOne(
      { projectId, assetId },
      {
        $set: {
          projectId,
          assetId,
          status: "failed",
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

  // 6. Explicitly check if source video has an audio stream
  const hasAudio = asset.audioCodec !== null ? true : await hasAudioStream(sourceFilePath).catch(() => false);
  if (!hasAudio) {
    const now = new Date();
    await col.updateOne(
      { projectId, assetId },
      {
        $set: {
          projectId,
          assetId,
          status: "no_audio",
          error: "The media asset does not contain an audio stream.",
          completedAt: now,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
    const updatedDoc = await col.findOne({ projectId, assetId });
    return toAudioExtractionDTO(updatedDoc!);
  }

  // 7. Verify FFmpeg availability
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

  // 8. Prepare analysis directories and target paths
  getAssetAnalysisDir(projectId, assetId);
  const finalAudioPath = resolveAssetAnalysisAudioPath(projectId, assetId);
  const tempAudioPath = resolveAssetAnalysisTempAudioPath(projectId, assetId);

  // Clean up any stale temporary files from prior attempts
  try {
    if (fs.existsSync(tempAudioPath)) {
      fs.unlinkSync(tempAudioPath);
    }
  } catch {
    // Ignore cleanup error
  }

  // 9. Update DB status to 'extracting'
  const now = new Date();
  await col.updateOne(
    { projectId, assetId },
    {
      $set: {
        projectId,
        assetId,
        status: "extracting",
        error: undefined,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );

  // 10. Construct FFmpeg command arguments:
  // Output format: WAV container, PCM signed 16-bit (pcm_s16le), mono (-ac 1), 16,000 Hz (-ar 16000)
  const ffmpegArgs = [
    "-y",
    "-i",
    sourceFilePath,
    "-vn",
    "-c:a",
    "pcm_s16le",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    tempAudioPath
  ];

  // Validate argument array safety
  validateFFmpegSafety(ffmpegArgs);

  const ffmpegBinary = getFFmpegPath();

  const runExtraction = (): Promise<AudioExtractionArtifact> => {
    return new Promise<AudioExtractionArtifact>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(ffmpegBinary, ffmpegArgs, { shell: false });
      } catch (spawnErr) {
        activeExtractions.delete(assetId);
        const errMsg = `Failed to spawn FFmpeg process: ${spawnErr instanceof Error ? spawnErr.message : "Unknown error"}`;
        col.updateOne(
          { projectId, assetId },
          { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
        ).catch(() => {});
        return reject(new Error(errMsg));
      }

      const activeEntry = activeExtractions.get(assetId);
      if (activeEntry) {
        activeEntry.process = proc;
      }

      let stderrData = "";

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString();
      });

      proc.on("error", async (err) => {
        activeExtractions.delete(assetId);
        // Clean up temporary file
        try {
          if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        } catch {}

        const errMsg = `FFmpeg process error: ${err.message}`;
        await col.updateOne(
          { projectId, assetId },
          { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
        );
        reject(new Error(errMsg));
      });

      proc.on("close", async (code) => {
        activeExtractions.delete(assetId);

        if (code !== 0) {
          // Clean up temporary file
          try {
            if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
          } catch {}

          const errMsg = `FFmpeg exited with code ${code}. ${stderrData.trim() || "Audio extraction failed."}`;
          await col.updateOne(
            { projectId, assetId },
            { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
          );
          return reject(new Error(errMsg));
        }

        // FFmpeg succeeded — now validate output with FFprobe
        try {
          if (!fs.existsSync(tempAudioPath)) {
            throw new Error("Temporary audio output file was not produced.");
          }

          const audioInfo = await inspectAudioFile(tempAudioPath);

          // Atomic promotion: rename tempAudioPath to finalAudioPath
          fs.renameSync(tempAudioPath, finalAudioPath);

          const completionTime = new Date();
          const updatedDoc = await col.findOneAndUpdate(
            { projectId, assetId },
            {
              $set: {
                status: "completed",
                audioProperties: {
                  format: audioInfo.format,
                  codec: audioInfo.codec,
                  sampleRate: audioInfo.sampleRate,
                  channels: audioInfo.channels,
                  bitDepth: audioInfo.bitDepth,
                  duration: audioInfo.duration
                },
                artifactSize: audioInfo.fileSize,
                completedAt: completionTime,
                error: undefined,
                updatedAt: completionTime
              }
            },
            { returnDocument: "after" }
          );

          if (!updatedDoc) {
            throw new Error("Failed to retrieve updated audio extraction document from database.");
          }

          resolve(toAudioExtractionDTO(updatedDoc));
        } catch (validationErr) {
          // Clean up temporary file if promotion or validation failed
          try {
            if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
          } catch {}

          const errMsg = `Output validation failed: ${validationErr instanceof Error ? validationErr.message : "Unknown error"}`;
          await col.updateOne(
            { projectId, assetId },
            { $set: { status: "failed", error: errMsg, updatedAt: new Date() } }
          );
          reject(new Error(errMsg));
        }
      });
    });
  };

  const activeEntry: ActiveExtraction = {
    assetId,
    projectId,
    tempPath: tempAudioPath,
    promise: Promise.resolve() as unknown as Promise<AudioExtractionArtifact>
  };
  activeExtractions.set(assetId, activeEntry);

  const extractionPromise = runExtraction();
  activeEntry.promise = extractionPromise;

  return extractionPromise;
}

/**
 * Cancels an active extraction for an asset if running.
 */
export function cancelActiveExtraction(assetId: string): boolean {
  const active = activeExtractions.get(assetId);
  if (!active) {
    return false;
  }

  try {
    if (active.process && !active.process.killed) {
      active.process.kill("SIGKILL");
    }
  } catch {}

  try {
    if (fs.existsSync(active.tempPath)) {
      fs.unlinkSync(active.tempPath);
    }
  } catch {}

  activeExtractions.delete(assetId);
  return true;
}

/**
 * Checks whether an audio extraction is currently active for an asset.
 */
export function isExtractionActive(assetId: string): boolean {
  return activeExtractions.has(assetId);
}

/**
 * Deletes all audio extraction metadata records associated with a project.
 * POLICY ENFORCEMENT: Deletion removes ONLY MongoDB metadata records.
 * It NEVER deletes original media files or completed exports.
 */
export async function deleteAudioExtractionsByProject(projectId: string): Promise<number> {
  const col = getCollection();
  const result = await col.deleteMany({ projectId });
  return result.deletedCount;
}

/**
 * Shuts down all active extraction processes and removes temporary files.
 */
export function registerAudioExtractionShutdownHooks(): void {
  const cleanup = () => {
    for (const [assetId, active] of activeExtractions.entries()) {
      try {
        if (active.process && !active.process.killed) {
          active.process.kill("SIGKILL");
        }
      } catch {}

      try {
        if (fs.existsSync(active.tempPath)) {
          fs.unlinkSync(active.tempPath);
        }
      } catch {}
    }
    activeExtractions.clear();
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
}
