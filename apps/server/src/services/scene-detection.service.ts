import { Collection, ObjectId } from "mongodb";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { getDB } from "../config/db.js";
import {
  resolveStoredFilePath,
  getSceneAnalysisDir,
  resolveSceneFramePath,
  resolveSceneFrameTempPath
} from "../config/storage.js";
import {
  SceneDetectionDocument,
  toSceneDetectionDTO
} from "../models/scene-detection.model.js";
import { getMediaAssetById } from "./media.service.js";
import { getProjectById } from "./project.service.js";
import { getFFmpegPath, checkFFmpegAvailable, validateFFmpegSafety } from "../utils/ffmpeg.js";
import { inspectVideo } from "../utils/ffprobe.js";
import type {
  SceneDetectionArtifact,
  SceneDetectionParameters,
  Scene
} from "@agentcut/shared";

const COLLECTION_NAME = "scene_detections";

export const DEFAULT_THRESHOLD = 0.3;
export const DEFAULT_MIN_SCENE_DURATION = 0.5;
export const DEFAULT_MAX_SCENES = 500;
export const MAX_ALLOWED_SCENES = 2000;
export const MAX_CONCURRENT_FRAME_EXTRACTIONS = Math.min(Math.max(1, os.cpus().length), 4);

// WeakSet tracking confirmed exited processes via exit/close events
const exitedProcesses = new WeakSet<ChildProcess>();

export function markProcessExited(proc: ChildProcess): void {
  exitedProcesses.add(proc);
}

/**
 * Determines whether a child process has actually exited based on confirmed OS lifecycle events:
 * - exitCode !== null
 * - signalCode !== null
 * - a recorded 'exit' or 'close' event
 * NOTE: proc.killed === true is intentionally NOT checked because it only indicates
 * that a signal was sent via Node.js, NOT that the process has exited.
 */
export function isProcessExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null || exitedProcesses.has(proc);
}

export interface ProcessTerminationResult {
  pid?: number;
  exited: boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}

export interface JobTerminationResult {
  allExited: boolean;
  unexitedPids: number[];
  results: ProcessTerminationResult[];
}

interface ActiveSceneJob {
  jobId: string;
  analysisId: string;
  projectId: string;
  assetId: string;
  parameters: SceneDetectionParameters;
  canceled: boolean;
  detectionProcess?: ChildProcess;
  activeFrameProcesses: Set<ChildProcess>;
  promise: Promise<SceneDetectionArtifact>;
  cancellationPromise?: Promise<boolean>;
}

// In-memory active detection map for concurrency deduplication: key = `${projectId}:${assetId}`
const activeJobs = new Map<string, ActiveSceneJob>();

function getCollection(): Collection<SceneDetectionDocument> {
  return getDB().collection<SceneDetectionDocument>(COLLECTION_NAME);
}

export async function initSceneDetectionIndexes(): Promise<void> {
  try {
    const col = getCollection();
    await col.createIndex({ projectId: 1, assetId: 1 });
    await col.createIndex({ projectId: 1 });
    await col.createIndex({ createdAt: -1 });
  } catch (err) {
    console.error("[SceneDetectionService] Error creating indexes:", err);
  }
}

/**
 * Validates and normalizes scene detection parameters with sensible boundaries.
 * - threshold: between 0.05 and 1.0 (default: 0.3, 2 decimal places)
 * - minSceneDuration: between 0.1 and 3600.0 (default: 0.5, 2 decimal places)
 * - maxScenes: between 1 and 2000 (default: 500)
 */
export function validateSceneDetectionParameters(
  raw?: Partial<SceneDetectionParameters>
): SceneDetectionParameters {
  let threshold = DEFAULT_THRESHOLD;
  let minSceneDuration = DEFAULT_MIN_SCENE_DURATION;
  let maxScenes = DEFAULT_MAX_SCENES;

  if (raw?.threshold !== undefined) {
    const val = Number(raw.threshold);
    if (isNaN(val) || val < 0.05 || val > 1.0) {
      throw new Error("threshold must be a valid number between 0.05 and 1.0.");
    }
    threshold = Math.round(val * 100) / 100;
  }

  if (raw?.minSceneDuration !== undefined) {
    const val = Number(raw.minSceneDuration);
    if (isNaN(val) || val < 0.1 || val > 3600.0) {
      throw new Error("minSceneDuration must be a valid number between 0.1 and 3600.0 seconds.");
    }
    minSceneDuration = Math.round(val * 100) / 100;
  }

  if (raw?.maxScenes !== undefined) {
    const val = Number(raw.maxScenes);
    if (isNaN(val) || !Number.isInteger(val) || val < 1 || val > MAX_ALLOWED_SCENES) {
      throw new Error(`maxScenes must be an integer between 1 and ${MAX_ALLOWED_SCENES}.`);
    }
    maxScenes = val;
  }

  return { threshold, minSceneDuration, maxScenes };
}

/**
 * Parses FFmpeg showinfo filter output from stderr to extract scene change cut timestamps and optional scores.
 * Filters out config lines and general diagnostics.
 */
export function parseShowinfoStderr(stderr: string): { timestamp: number; score?: number }[] {
  const lines = stderr.split(/\r?\n/);
  const cuts: { timestamp: number; score?: number }[] = [];

  for (const line of lines) {
    // Look for showinfo output with frame index and pts_time: e.g. [Parsed_showinfo_1 @ ...] n: 0 pts: 12800 pts_time:1.000000
    if (line.includes("showinfo") && /n:\s*\d+/.test(line)) {
      const match = line.match(/pts_time:\s*([0-9.]+)/);
      if (match) {
        const ts = parseFloat(match[1]);
        if (!isNaN(ts) && ts >= 0) {
          cuts.push({ timestamp: ts });
        }
      }
    } else if (line.includes("lavfi.scene_score=") || line.includes("scene_score:")) {
      const scoreMatch = line.match(/(?:lavfi\.scene_score=|scene_score:\s*)([0-9.]+)/);
      if (scoreMatch && cuts.length > 0) {
        const scoreVal = parseFloat(scoreMatch[1]);
        if (!isNaN(scoreVal)) {
          cuts[cuts.length - 1].score = scoreVal;
        }
      }
    }
  }

  return cuts;
}

/**
 * Deterministically constructs continuous, non-overlapping scene intervals from detected cut points.
 * Guarantees:
 * 1. Scene 0 starts strictly at 0.000s.
 * 2. Final scene ends strictly at videoDuration.
 * 3. Cuts closer than minSceneDuration are merged into the preceding scene.
 * 4. Cuts leaving less than minSceneDuration before videoDuration are merged.
 * 5. Every scene has valid positive duration and representative midpoint timestamp.
 * 6. Total scenes bounded by maxScenes.
 */
export function buildSceneIntervals(
  rawCuts: { timestamp: number; score?: number }[],
  videoDuration: number,
  minSceneDuration: number,
  maxScenes: number,
  analysisId: string
): Scene[] {
  const duration = Math.round(videoDuration * 1000) / 1000;
  if (duration <= 0) {
    throw new Error(`Invalid video duration: ${videoDuration}s.`);
  }

  // 1. Filter cut timestamps strictly within (0, duration)
  const validCuts = rawCuts
    .filter((c) => c.timestamp > 0 && c.timestamp < duration)
    .sort((a, b) => a.timestamp - b.timestamp);

  // 2. Greedy selection enforcing minSceneDuration separation and trailing margin
  const acceptedCuts: { timestamp: number; score?: number }[] = [];
  let lastCutTimestamp = 0;

  for (const cut of validCuts) {
    const timeSinceLast = cut.timestamp - lastCutTimestamp;
    const timeUntilEnd = duration - cut.timestamp;

    if (timeSinceLast >= minSceneDuration && timeUntilEnd >= minSceneDuration) {
      acceptedCuts.push(cut);
      lastCutTimestamp = cut.timestamp;
    }
  }

  // 3. Enforce maxScenes limit
  let finalCuts = acceptedCuts;
  if (finalCuts.length >= maxScenes) {
    // If cuts have scores, prioritize highest scores; otherwise take the first (maxScenes - 1) cuts deterministically
    const hasScores = finalCuts.some((c) => typeof c.score === "number");
    if (hasScores) {
      const sortedByScore = [...finalCuts].sort((a, b) => (b.score || 0) - (a.score || 0));
      const topCuts = sortedByScore.slice(0, maxScenes - 1);
      finalCuts = topCuts.sort((a, b) => a.timestamp - b.timestamp);
    } else {
      finalCuts = finalCuts.slice(0, maxScenes - 1);
    }
  }

  // 4. Construct contiguous scenes [0, c_1], [c_1, c_2], ..., [c_k, duration]
  const boundaryPoints = [0, ...finalCuts.map((c) => Math.round(c.timestamp * 1000) / 1000), duration];
  const scenes: Scene[] = [];

  for (let i = 0; i < boundaryPoints.length - 1; i++) {
    const start = boundaryPoints[i];
    const end = boundaryPoints[i + 1];
    const sceneDuration = Math.round((end - start) * 1000) / 1000;

    // Midpoint timestamp safely clamped within [start, min(end - 0.001, duration)]
    const rawMidpoint = Math.round(((start + end) / 2) * 1000) / 1000;
    const representativeTimestamp = Math.max(start, Math.min(rawMidpoint, Math.max(start, end - 0.001)));

    const sceneId = `${analysisId}_s${i}`;
    scenes.push({
      id: sceneId,
      index: i,
      start,
      end,
      duration: sceneDuration,
      representativeTimestamp,
      score: finalCuts[i]?.score,
      frameAvailable: false
    });
  }

  return scenes;
}

/**
 * Safely terminates an operating system process with an escalating grace period:
 * 1. Attaches 'exit', 'close', and 'error' listeners before sending any signal.
 * 2. Checks if process is already exited (exitCode !== null || signalCode !== null || recorded close).
 * 3. Sends SIGTERM first.
 * 4. After gracePeriodMs (default 1000ms), escalates to SIGKILL if the process has not yet exited.
 * 5. After SIGKILL, continues awaiting the actual 'close' or 'exit' event until hardDeadlineMs (default 3000ms).
 * 6. Never treats proc.killed === true as proof of process exit.
 * 7. If process still has not exited when hardDeadlineMs expires, returns { exited: false, pid }.
 */
export async function terminateProcessWithGracePeriod(
  proc: ChildProcess,
  gracePeriodMs = 1000,
  hardDeadlineMs = 3000
): Promise<ProcessTerminationResult> {
  if (isProcessExited(proc)) {
    return {
      pid: proc.pid,
      exited: true,
      exitCode: proc.exitCode,
      signalCode: proc.signalCode
    };
  }

  return new Promise<ProcessTerminationResult>((resolve) => {
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (graceTimer) clearTimeout(graceTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      proc.removeListener("exit", onExit);
      proc.removeListener("close", onClose);
      proc.removeListener("error", onError);
    };

    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (exited) {
        markProcessExited(proc);
      }
      resolve({
        pid: proc.pid,
        exited,
        exitCode: proc.exitCode,
        signalCode: proc.signalCode
      });
    };

    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const onError = () => {
      // An error event alone cannot establish that a running process has exited.
      // Settle only if actual process lifecycle confirms exit.
      if (isProcessExited(proc)) {
        finish(true);
      }
    };

    // 1. Attach listeners BEFORE sending termination signal
    proc.once("exit", onExit);
    proc.once("close", onClose);
    proc.once("error", onError);

    // Double-check in case process exited during listener attachment
    if (isProcessExited(proc)) {
      return finish(true);
    }

    // 2. Send initial SIGTERM
    try {
      proc.kill("SIGTERM");
    } catch (err: any) {
      if (err?.code === "ESRCH") {
        return finish(true);
      }
    }

    // 3. Escalate to SIGKILL after grace period if still not exited
    graceTimer = setTimeout(() => {
      if (settled) return;
      if (!isProcessExited(proc)) {
        try {
          proc.kill("SIGKILL");
        } catch (err: any) {
          if (err?.code === "ESRCH") {
            return finish(true);
          }
        }
      }
    }, gracePeriodMs);

    // 4. Hard deadline: continue awaiting exit/close event even after SIGKILL
    deadlineTimer = setTimeout(() => {
      if (settled) return;
      const exited = isProcessExited(proc);
      if (!exited) {
        console.warn(
          `[SceneDetectionService] Process (PID: ${proc.pid}) did not exit within ${hardDeadlineMs}ms deadline.`
        );
      }
      finish(exited);
    }, hardDeadlineMs);
  });
}

/**
 * Gracefully terminates all active child processes for a job (detection and frame extractions),
 * awaiting their exit events up to a bounded timeout before directory cleanup.
 * Guarantees:
 * - Marks job canceled so no new tasks are dequeued.
 * - Gathers only processes that have not already exited.
 * - Escalates SIGTERM -> SIGKILL with continuous awaiting of actual exit events.
 * - Reports whether all processes successfully exited and lists any unexited PIDs.
 */
export async function terminateJobProcesses(
  job: ActiveSceneJob,
  gracePeriodMs = 1000,
  hardDeadlineMs = 3000
): Promise<JobTerminationResult> {
  // 1. Mark job canceled so no new tasks are dequeued
  job.canceled = true;

  // Gather all active child processes that haven't exited
  const processes: ChildProcess[] = [];
  if (job.detectionProcess && !isProcessExited(job.detectionProcess)) {
    processes.push(job.detectionProcess);
  }
  for (const proc of job.activeFrameProcesses) {
    if (!isProcessExited(proc)) {
      processes.push(proc);
    }
  }

  if (processes.length === 0) {
    return { allExited: true, unexitedPids: [], results: [] };
  }

  const results = await Promise.all(
    processes.map((proc) => terminateProcessWithGracePeriod(proc, gracePeriodMs, hardDeadlineMs))
  );

  const unexitedPids: number[] = [];
  for (const res of results) {
    if (!res.exited && res.pid !== undefined) {
      unexitedPids.push(res.pid);
    }
  }

  return {
    allExited: unexitedPids.length === 0,
    unexitedPids,
    results
  };
}

/**
 * Extracts representative frames with bounded concurrency.
 * Ensures temporary files are written first and atomically renamed, avoiding partial frame artifacts.
 */
async function extractRepresentativeFrames(
  job: ActiveSceneJob,
  videoPath: string,
  scenes: Scene[],
  projectId: string,
  assetId: string,
  analysisId: string
): Promise<void> {
  const binary = getFFmpegPath();
  const queue = [...scenes];

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      if (job.canceled) return;
      const scene = queue.shift();
      if (!scene) break;

      const tempPath = resolveSceneFrameTempPath(projectId, assetId, analysisId, scene.id, job.jobId);
      const finalPath = resolveSceneFramePath(projectId, assetId, analysisId, scene.id);

      const args = [
        "-hide_banner",
        "-nostdin",
        "-ss",
        scene.representativeTimestamp.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-vf",
        "scale='min(640,iw)':-2",
        "-y",
        tempPath
      ];

      validateFFmpegSafety(args);

      try {
        await new Promise<void>((resolve, reject) => {
          if (job.canceled) {
            return reject(new Error("Analysis was canceled."));
          }

          const proc = spawn(binary, args, { shell: false });
          proc.once("exit", () => markProcessExited(proc));
          proc.once("close", () => markProcessExited(proc));
          job.activeFrameProcesses.add(proc);

          proc.on("error", (err) => {
            // Note: do not delete from activeFrameProcesses here; process may still be running.
            // The 'close' event handler is the sole authority for confirmed process termination.
            reject(err);
          });

          proc.on("close", (code) => {
            job.activeFrameProcesses.delete(proc);
            if (job.canceled) {
              if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch {}
              }
              return reject(new Error("Analysis was canceled."));
            }
            if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
              try {
                fs.renameSync(tempPath, finalPath);
                scene.frameAvailable = true;
              } catch (renameErr) {
                console.error(`[SceneDetectionService] Failed to rename temp frame ${tempPath}:`, renameErr);
              }
              resolve();
            } else {
              // Frame extraction failure for a single frame: log warning but don't abort entire analysis
              if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch {}
              }
              console.warn(`[SceneDetectionService] Warning: Frame extraction for scene ${scene.id} exited with code ${code}.`);
              resolve();
            }
          });
        });
      } catch (err) {
        if (job.canceled) return;
        console.warn(`[SceneDetectionService] Warning: Frame extraction worker error for scene ${scene.id}:`, err);
      }
    }
  };

  const workers: Promise<void>[] = [];
  const concurrency = Math.min(MAX_CONCURRENT_FRAME_EXTRACTIONS, scenes.length);
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
}

/**
 * Initiates or returns scene detection for a media asset.
 * Enforces:
 * 1. Prerequisite verification: media asset must exist, belong to project, and contain a valid video stream.
 * 2. Concurrency control:
 *    - Synchronous active job registration to eliminate race conditions between parallel callers.
 *    - Identical parameters: return in-flight promise (deduplication).
 *    - Different parameters during active run: replace-and-cancel policy. Cancels old in-flight job, cleans up old directory, starts replacement in new directory.
 * 3. Cache reuse: if matching completed analysis exists and frames exist on disk, return cached result.
 * 4. Cancellation safety: if canceled, aborts frame extraction and cleans up the analysis directory.
 * 5. Preserves last completed analysis if replacement fails.
 */
export async function requestSceneDetection(
  projectId: string,
  assetId: string,
  rawParams?: Partial<SceneDetectionParameters>
): Promise<SceneDetectionArtifact> {
  const params = validateSceneDetectionParameters(rawParams);
  const activeKey = `${projectId}:${assetId}`;

  // 1. Concurrency check: immediately check activeJobs synchronously
  const existingJob = activeJobs.get(activeKey);
  if (existingJob) {
    if (
      existingJob.parameters.threshold === params.threshold &&
      existingJob.parameters.minSceneDuration === params.minSceneDuration &&
      existingJob.parameters.maxScenes === params.maxScenes
    ) {
      // Deduplicate request with identical parameters: return same in-flight promise
      return existingJob.promise;
    } else {
      // Replace-and-cancel policy: cancel obsolete in-flight job with different parameters
      existingJob.canceled = true;
      if (existingJob.cancellationPromise) {
        await existingJob.cancellationPromise;
      } else {
        const termResult = await terminateJobProcesses(existingJob);
        if (termResult.allExited) {
          const oldDir = getSceneAnalysisDir(projectId, assetId, existingJob.analysisId);
          if (fs.existsSync(oldDir)) {
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch {}
          }
        } else {
          console.warn(`[SceneDetectionService] Preserving directory for replaced analysis ${existingJob.analysisId} because child processes (${termResult.unexitedPids.join(", ")}) failed to exit.`);
        }
        const col = getCollection();
        await col.updateOne(
          { _id: new ObjectId(existingJob.analysisId) },
          {
            $set: {
              status: termResult.allExited ? "canceled" : "failed",
              error: termResult.allExited ? "Scene detection was replaced with different parameters." : `Scene detection replacement interrupted: processes (${termResult.unexitedPids.join(", ")}) failed to exit. Directory preserved.`,
              updatedAt: new Date()
            }
          }
        ).catch(() => {});
      }
      activeJobs.delete(activeKey);
    }
  }

  // 2. Synchronous job registration to ensure concurrent requests in the same tick join the same promise
  const analysisDocId = new ObjectId();
  const analysisId = analysisDocId.toHexString();
  const jobId = crypto.randomUUID();

  let resolveActivePromise!: (artifact: SceneDetectionArtifact) => void;
  let rejectActivePromise!: (err: Error) => void;
  const activePromise = new Promise<SceneDetectionArtifact>((resolve, reject) => {
    resolveActivePromise = resolve;
    rejectActivePromise = reject;
  });

  const activeJob: ActiveSceneJob = {
    jobId,
    analysisId,
    projectId,
    assetId,
    parameters: params,
    canceled: false,
    activeFrameProcesses: new Set(),
    promise: activePromise
  };
  activeJobs.set(activeKey, activeJob);

  // 3. Execution closure
  const runDetection = async (): Promise<SceneDetectionArtifact> => {
    const col = getCollection();
    let analysisDir = "";

    try {
      // A. Verify project exists
      const project = await getProjectById(projectId);
      if (!project) {
        throw new Error(`Project '${projectId}' not found.`);
      }

      // B. Verify media asset exists and belongs to this project
      const mediaAssetData = await getMediaAssetById(projectId, assetId);
      if (!mediaAssetData) {
        throw new Error(`Media asset '${assetId}' not found in project '${projectId}'.`);
      }

      const videoFilePath = resolveStoredFilePath(projectId, mediaAssetData.storedFileName);
      if (!fs.existsSync(videoFilePath)) {
        throw new Error("Media file not found on disk.");
      }

      // C. Inspect video metadata
      const metadata = await inspectVideo(videoFilePath);
      if (!metadata.videoCodec || metadata.videoCodec === "none" || metadata.duration <= 0) {
        throw new Error("Media asset does not contain a valid video stream for scene detection.");
      }
      const videoDuration = metadata.duration;

      // D. Verify FFmpeg availability
      const isAvailable = await checkFFmpegAvailable();
      if (!isAvailable) {
        throw new Error("FFmpeg executable not found or not functional on the system.");
      }

      // E. Cache check: find latest completed analysis matching parameters
      const cachedDoc = await col.findOne(
        {
          projectId,
          assetId,
          status: "completed",
          "parameters.threshold": params.threshold,
          "parameters.minSceneDuration": params.minSceneDuration,
          "parameters.maxScenes": params.maxScenes
        },
        { sort: { createdAt: -1 } }
      );

      if (cachedDoc) {
        const cachedAnalysisDir = getSceneAnalysisDir(projectId, assetId, cachedDoc._id.toHexString());
        if (fs.existsSync(cachedAnalysisDir)) {
          const allFramesExist = (cachedDoc.scenes || []).every((s) => {
            if (!s.frameAvailable) return true;
            const framePath = resolveSceneFramePath(projectId, assetId, cachedDoc._id.toHexString(), s.id);
            return fs.existsSync(framePath);
          });
          if (allFramesExist) {
            return toSceneDetectionDTO(cachedDoc);
          }
        }
      }

      if (activeJob.canceled) {
        throw new Error("Scene detection was canceled by user.");
      }

      // F. Insert new analysis record in MongoDB with 'detecting' status
      const now = new Date();
      await col.insertOne({
        _id: analysisDocId,
        projectId,
        assetId,
        status: "detecting",
        parameters: params,
        scenes: [],
        sceneCount: 0,
        videoDuration,
        createdAt: now,
        updatedAt: now
      });

      // Ensure isolated analysis directory exists
      analysisDir = getSceneAnalysisDir(projectId, assetId, analysisId);

      // G. Run FFmpeg scene cut detection
      const binary = getFFmpegPath();
      const filterArg = `select='gt(scene,${params.threshold})',showinfo`;
      const args = ["-hide_banner", "-nostdin", "-i", videoFilePath, "-vf", filterArg, "-f", "null", "-"];

      validateFFmpegSafety(args);

      let stderrOutput = "";
      const errorDiagnostics: string[] = [];

      await new Promise<void>((resolve, reject) => {
        if (activeJob.canceled) {
          return reject(new Error("Scene detection was canceled by user."));
        }

        const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
        proc.once("exit", () => markProcessExited(proc));
        proc.once("close", () => markProcessExited(proc));
        activeJob.detectionProcess = proc;

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderrOutput += text;

          const lines = text.split(/\r?\n/);
          for (const line of lines) {
            if (line && !line.includes("showinfo") && !line.includes("frame=") && errorDiagnostics.length < 50) {
              errorDiagnostics.push(line);
            }
          }
        });

        proc.on("error", (err) => {
          reject(err);
        });

        proc.on("close", (code, signal) => {
          if (activeJob.canceled) {
            return reject(new Error("Scene detection was canceled by user."));
          }
          if (code === 0) {
            resolve();
          } else {
            const errSummary = errorDiagnostics.join(" ").trim() || `Exit code ${code}${signal ? `, signal: ${signal}` : ""}`;
            reject(new Error(`FFmpeg scene detection failed: ${errSummary}`));
          }
        });
      });

      if (activeJob.canceled) {
        throw new Error("Scene detection was canceled by user.");
      }

      // H. Parse cut timestamps strictly from showinfo stderr lines
      const rawCuts = parseShowinfoStderr(stderrOutput);

      // I. Build continuous, non-overlapping scene intervals
      const scenes = buildSceneIntervals(rawCuts, videoDuration, params.minSceneDuration, params.maxScenes, analysisId);

      // J. Extract representative frames with bounded concurrency
      await extractRepresentativeFrames(activeJob, videoFilePath, scenes, projectId, assetId, analysisId);

      if (activeJob.canceled) {
        throw new Error("Scene detection was canceled by user.");
      }

      // K. Atomic conditional MongoDB update: only complete if status is NOT 'canceled'
      const completionTime = new Date();
      const updatedDoc = await col.findOneAndUpdate(
        { _id: analysisDocId, status: { $ne: "canceled" } },
        {
          $set: {
            status: "completed",
            parameters: params,
            scenes,
            sceneCount: scenes.length,
            videoDuration,
            completedAt: completionTime,
            error: undefined,
            updatedAt: completionTime
          }
        },
        { returnDocument: "after" }
      );

      // Check whether the document was canceled or conditional update matched nothing
      if (!updatedDoc) {
        if (analysisDir && fs.existsSync(analysisDir)) {
          try { fs.rmSync(analysisDir, { recursive: true, force: true }); } catch {}
        }
        throw new Error("Scene detection was canceled by user.");
      }

      return toSceneDetectionDTO(updatedDoc);
    } catch (err) {
      const termResult = await terminateJobProcesses(activeJob);

      if (termResult.allExited && analysisDir && fs.existsSync(analysisDir)) {
        try { fs.rmSync(analysisDir, { recursive: true, force: true }); } catch {}
      } else if (!termResult.allExited) {
        console.warn(`[SceneDetectionService] Preserved directory ${analysisDir} because child processes (${termResult.unexitedPids.join(", ")}) failed to exit.`);
      }

      const isCanceled = activeJob.canceled || (err instanceof Error && err.message.includes("canceled"));
      const finalStatus = !termResult.allExited ? "failed" : (isCanceled ? "canceled" : "failed");
      const errMsg = !termResult.allExited
        ? `Scene detection terminated with unexited processes (${termResult.unexitedPids.join(", ")}). Directory preserved.`
        : (isCanceled ? "Scene detection was canceled by user." : (err instanceof Error ? err.message : "Scene detection failed."));

      await col.updateOne(
        { _id: analysisDocId },
        {
          $set: {
            projectId,
            assetId,
            status: finalStatus,
            parameters: params,
            error: errMsg,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date(),
            scenes: [],
            sceneCount: 0,
            videoDuration: 0
          }
        },
        { upsert: true }
      ).catch(() => {});

      throw err;
    } finally {
      const currentActive = activeJobs.get(activeKey);
      if (currentActive && currentActive.analysisId === analysisId) {
        activeJobs.delete(activeKey);
      }
    }
  };

  runDetection().then(resolveActivePromise, rejectActivePromise);
  return activePromise;
}

/**
 * Cancels an active scene detection for a media asset.
 * Guarantees:
 * 1. Synchronously marks job canceled and registers shared cancellation promise.
 * 2. Concurrent calls return identical cancellation promise and do not duplicate termination or cleanup.
 * 3. Escalates SIGTERM -> SIGKILL and awaits actual OS exit/close events of all child processes.
 * 4. If any process fails to exit, does NOT remove analysis directory, records failure, and returns false.
 * 5. Only deletes directory if all child processes have fully exited.
 */
export async function cancelActiveSceneDetection(projectId: string, assetId: string): Promise<boolean> {
  const activeKey = `${projectId}:${assetId}`;
  const active = activeJobs.get(activeKey);

  if (active) {
    if (active.cancellationPromise) {
      return active.cancellationPromise;
    }

    active.canceled = true;

    active.cancellationPromise = (async (): Promise<boolean> => {
      try {
        // Await actual exit/close of all active child processes before directory cleanup
        const termResult = await terminateJobProcesses(active);
        const analysisDir = getSceneAnalysisDir(active.projectId, active.assetId, active.analysisId);

        if (!termResult.allExited) {
          console.error(
            `[SceneDetectionService] Cancellation aborted directory cleanup: child processes (${termResult.unexitedPids.join(
              ", "
            )}) failed to exit.`
          );

          const col = getCollection();
          await col.updateOne(
            { _id: new ObjectId(active.analysisId) },
            {
              $set: {
                projectId: active.projectId,
                assetId: active.assetId,
                status: "failed",
                parameters: active.parameters,
                error: `Scene detection cancellation incomplete: processes (${termResult.unexitedPids.join(
                  ", "
                )}) failed to exit. Directory preserved.`,
                updatedAt: new Date()
              },
              $setOnInsert: {
                createdAt: new Date(),
                scenes: [],
                sceneCount: 0,
                videoDuration: 0
              }
            },
            { upsert: true }
          ).catch(() => {});

          return false;
        }

        // Only after all child processes have exited, remove temporary files and the analysis-specific directory
        if (fs.existsSync(analysisDir)) {
          try {
            fs.rmSync(analysisDir, { recursive: true, force: true });
          } catch (rmErr) {
            console.error(`[SceneDetectionService] Error cleaning analysis dir ${analysisDir}:`, rmErr);
          }
        }

        // Mark canceled in database
        const col = getCollection();
        await col.updateOne(
          { _id: new ObjectId(active.analysisId) },
          {
            $set: {
              projectId: active.projectId,
              assetId: active.assetId,
              status: "canceled",
              parameters: active.parameters,
              error: "Scene detection was canceled by user.",
              updatedAt: new Date()
            },
            $setOnInsert: {
              createdAt: new Date(),
              scenes: [],
              sceneCount: 0,
              videoDuration: 0
            }
          },
          { upsert: true }
        ).catch(() => {});

        return true;
      } finally {
        activeJobs.delete(activeKey);
      }
    })();

    return active.cancellationPromise;
  }

  // Also check database for any in-flight 'detecting' document for this asset
  const col = getCollection();
  const updateResult = await col.updateMany(
    { projectId, assetId, status: "detecting" },
    { $set: { status: "canceled", error: "Scene detection was canceled by user.", updatedAt: new Date() } }
  );

  return updateResult.modifiedCount > 0;
}

/**
 * Checks whether scene detection is currently active for an asset.
 */
export function isSceneDetectionActive(projectId: string, assetId: string): boolean {
  const activeKey = `${projectId}:${assetId}`;
  return activeJobs.has(activeKey);
}

/**
 * Retrieves scene detection for an asset.
 * If analysisId is provided, retrieves that specific analysis.
 * Otherwise retrieves the latest completed analysis (or latest active/failed if none completed).
 */
export async function getSceneDetection(
  projectId: string,
  assetId: string,
  analysisId?: string
): Promise<SceneDetectionArtifact | null> {
  const col = getCollection();

  if (analysisId) {
    if (!ObjectId.isValid(analysisId)) {
      return null;
    }
    const doc = await col.findOne({ _id: new ObjectId(analysisId), projectId, assetId });
    return doc ? toSceneDetectionDTO(doc) : null;
  }

  // Prefer latest completed analysis
  const completed = await col.findOne({ projectId, assetId, status: "completed" }, { sort: { createdAt: -1 } });
  if (completed) {
    return toSceneDetectionDTO(completed);
  }

  // Fallback to latest overall
  const latest = await col.findOne({ projectId, assetId }, { sort: { createdAt: -1 } });
  return latest ? toSceneDetectionDTO(latest) : null;
}

/**
 * Retrieves and validates a representative frame for streaming.
 * Checks project, asset, analysis, and scene ownership.
 * Returns physical path, size, and strong SHA-256 ETag.
 */
export async function getSceneFrame(
  projectId: string,
  assetId: string,
  analysisId: string,
  sceneId: string
): Promise<{ filePath: string; fileSize: number; etag: string } | null> {
  if (!ObjectId.isValid(projectId) || !ObjectId.isValid(assetId) || !ObjectId.isValid(analysisId)) {
    return null;
  }

  // Safe sceneId regex: alphanumeric, underscores, hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(sceneId)) {
    return null;
  }

  const col = getCollection();
  const doc = await col.findOne({
    _id: new ObjectId(analysisId),
    projectId,
    assetId,
    status: "completed"
  });

  if (!doc) {
    return null;
  }

  const sceneExists = (doc.scenes || []).some((s) => s.id === sceneId);
  if (!sceneExists) {
    return null;
  }

  const framePath = resolveSceneFramePath(projectId, assetId, analysisId, sceneId);
  if (!fs.existsSync(framePath)) {
    return null;
  }

  const stat = fs.statSync(framePath);
  if (stat.size <= 0) {
    return null;
  }

  // Generate strong ETag from SHA-256 hash of frame content
  const hash = crypto.createHash("sha256").update(fs.readFileSync(framePath)).digest("hex");
  const etag = `"${hash}"`;

  return { filePath: framePath, fileSize: stat.size, etag };
}

/**
 * Cascading metadata deletion when a project is deleted.
 * POLICY ENFORCEMENT: Removes only MongoDB records; original media files and directories remain intact.
 */
export async function deleteSceneDetectionsByProject(projectId: string): Promise<number> {
  const col = getCollection();
  const res = await col.deleteMany({ projectId });
  return res.deletedCount;
}

/**
 * Graceful server shutdown hook.
 * Terminates all running detection and frame extraction child processes cleanly and cleans up temp directories.
 * Strictly guarantees that analysis directories are only removed after all child processes have fully exited.
 */
export function registerSceneDetectionShutdownHooks(): void {
  const shutdown = async () => {
    const jobs = Array.from(activeJobs.values());
    activeJobs.clear();

    await Promise.all(
      jobs.map(async (job) => {
        job.canceled = true;
        // Bounded wait up to 2000ms for child process exit during shutdown
        const termResult = await terminateJobProcesses(job, 1000, 2000);
        if (termResult.allExited) {
          const dir = getSceneAnalysisDir(job.projectId, job.assetId, job.analysisId);
          if (fs.existsSync(dir)) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          }
        } else {
          console.warn(
            `[SceneDetectionService] Graceful shutdown: preserved directory for analysis ${job.analysisId} because child processes (${termResult.unexitedPids.join(", ")}) failed to exit.`
          );
        }
      })
    );
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
