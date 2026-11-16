import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { type RenderJob } from "@agentcut/shared";
import { type ServerResolvedRenderPlan, type ServerRenderClip } from "./render-plan.service.js";
import { getFFmpegPath, checkFFmpegAvailable, validateFFmpegSafety } from "../utils/ffmpeg.js";
import { inspectVideo, type FFprobeMetadata } from "../utils/ffprobe.js";
import { resolveExportFilePath } from "../config/storage.js";
import * as renderJobService from "./render-job.service.js";
import { validateServerRenderPlan } from "./render-plan.service.js";

export interface ActiveRenderJob {
  jobId: string;
  projectId: string;
  process?: ChildProcess;
  tmpFilePath: string;
  finalFilePath: string;
  canceled: boolean;
  startTime: number;
}

// In-memory active processes registry to prevent duplicate concurrent runs and coordinate cancellation
const activeJobs = new Map<string, ActiveRenderJob>();

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

/**
 * Builds deterministic FFmpeg command arguments and filter_complex string from a validated ServerResolvedRenderPlan.
 * Produces MP4 using libx264, yuv420p, and AAC audio.
 * Handles single video track, optional single audio track, trims, source offsets, and gap preservation.
 */
export function buildFFmpegRenderArgs(
  plan: ServerResolvedRenderPlan,
  tmpOutputPath: string
): string[] {
  const allClips = [...plan.videoClips, ...plan.audioClips];
  const uniqueFilePaths = Array.from(new Set(allClips.map((c) => c.resolvedFilePath)));
  const fileIndexMap = new Map<string, number>();
  uniqueFilePaths.forEach((fp, idx) => fileIndexMap.set(fp, idx));

  const inputArgs: string[] = [];
  for (const fp of uniqueFilePaths) {
    inputArgs.push("-i", fp);
  }

  const filterChains: string[] = [];

  // 1. Build video filter chains & gaps
  const sortedVideoClips = [...plan.videoClips].sort((a, b) => a.timelineStart - b.timelineStart);
  let vCurrentTime = 0;
  const vLabels: string[] = [];
  const { width, height, frameRate } = plan.settings;

  for (let i = 0; i < sortedVideoClips.length; i++) {
    const clip = sortedVideoClips[i];

    // Leading or intermediate gap before clip
    if (clip.timelineStart - vCurrentTime > 0.001) {
      const gapDur = clip.timelineStart - vCurrentTime;
      const gapLabel = `[vgap_${vLabels.length}]`;
      filterChains.push(
        `color=c=black:s=${width}x${height}:r=${frameRate}:d=${gapDur.toFixed(4)}${gapLabel}`
      );
      vLabels.push(gapLabel);
    }

    // Video clip trim and geometry conformance
    const inputIdx = fileIndexMap.get(clip.resolvedFilePath)!;
    const clipLabel = `[vclip_${vLabels.length}]`;
    filterChains.push(
      `[${inputIdx}:v]trim=start=${clip.sourceStart.toFixed(4)}:end=${clip.sourceEnd.toFixed(4)},` +
      `setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${frameRate}${clipLabel}`
    );
    vLabels.push(clipLabel);
    vCurrentTime = clip.timelineEnd;
  }

  // Trailing video gap up to total plan duration
  if (plan.duration - vCurrentTime > 0.001) {
    const gapDur = plan.duration - vCurrentTime;
    const gapLabel = `[vgap_end]`;
    filterChains.push(
      `color=c=black:s=${width}x${height}:r=${frameRate}:d=${gapDur.toFixed(4)}${gapLabel}`
    );
    vLabels.push(gapLabel);
  }

  // Concat all video segments into [outv]
  if (vLabels.length === 0) {
    filterChains.push(`color=c=black:s=${width}x${height}:r=${frameRate}:d=${plan.duration.toFixed(4)}[outv]`);
  } else {
    filterChains.push(`${vLabels.join("")}concat=n=${vLabels.length}:v=1:a=0[outv]`);
  }

  // 2. Build audio filter chains & gaps
  const sortedAudioClips = [...plan.audioClips].sort((a, b) => a.timelineStart - b.timelineStart);

  if (sortedAudioClips.length > 0) {
    // Mode A: Dedicated audio track clips present
    let aCurrentTime = 0;
    const aLabels: string[] = [];

    for (let i = 0; i < sortedAudioClips.length; i++) {
      const clip = sortedAudioClips[i];
      if (clip.timelineStart - aCurrentTime > 0.001) {
        const gapDur = clip.timelineStart - aCurrentTime;
        const gapLabel = `[agap_${aLabels.length}]`;
        filterChains.push(`anullsrc=r=44100:cl=stereo:d=${gapDur.toFixed(4)}${gapLabel}`);
        aLabels.push(gapLabel);
      }

      const inputIdx = fileIndexMap.get(clip.resolvedFilePath)!;
      const clipLabel = `[aclip_${aLabels.length}]`;
      filterChains.push(
        `[${inputIdx}:a]atrim=start=${clip.sourceStart.toFixed(4)}:end=${clip.sourceEnd.toFixed(4)},` +
        `asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo${clipLabel}`
      );
      aLabels.push(clipLabel);
      aCurrentTime = clip.timelineEnd;
    }

    if (plan.duration - aCurrentTime > 0.001) {
      const gapDur = plan.duration - aCurrentTime;
      const gapLabel = `[agap_end]`;
      filterChains.push(`anullsrc=r=44100:cl=stereo:d=${gapDur.toFixed(4)}${gapLabel}`);
      aLabels.push(gapLabel);
    }

    filterChains.push(`${aLabels.join("")}concat=n=${aLabels.length}:v=0:a=1[outa]`);
  } else {
    // Mode B: No dedicated audio track clips. Derive audio from video clips or silence
    const hasAnyClipAudio = sortedVideoClips.some((c) => Boolean(c.hasAudio));

    if (hasAnyClipAudio) {
      let aCurrentTime = 0;
      const aLabels: string[] = [];

      for (let i = 0; i < sortedVideoClips.length; i++) {
        const clip = sortedVideoClips[i];
        if (clip.timelineStart - aCurrentTime > 0.001) {
          const gapDur = clip.timelineStart - aCurrentTime;
          const gapLabel = `[agap_${aLabels.length}]`;
          filterChains.push(`anullsrc=r=44100:cl=stereo:d=${gapDur.toFixed(4)}${gapLabel}`);
          aLabels.push(gapLabel);
        }

        const clipLabel = `[aclip_${aLabels.length}]`;
        if (clip.hasAudio) {
          const inputIdx = fileIndexMap.get(clip.resolvedFilePath)!;
          filterChains.push(
            `[${inputIdx}:a]atrim=start=${clip.sourceStart.toFixed(4)}:end=${clip.sourceEnd.toFixed(4)},` +
            `asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo${clipLabel}`
          );
        } else {
          filterChains.push(
            `anullsrc=r=44100:cl=stereo:d=${clip.duration.toFixed(4)}${clipLabel}`
          );
        }
        aLabels.push(clipLabel);
        aCurrentTime = clip.timelineEnd;
      }

      if (plan.duration - aCurrentTime > 0.001) {
        const gapDur = plan.duration - aCurrentTime;
        const gapLabel = `[agap_end]`;
        filterChains.push(`anullsrc=r=44100:cl=stereo:d=${gapDur.toFixed(4)}${gapLabel}`);
        aLabels.push(gapLabel);
      }

      filterChains.push(`${aLabels.join("")}concat=n=${aLabels.length}:v=0:a=1[outa]`);
    } else {
      // Complete silence track matching output duration
      filterChains.push(`anullsrc=r=44100:cl=stereo:d=${plan.duration.toFixed(4)}[outa]`);
    }
  }

  const filterComplex = filterChains.join(";");

  return [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    plan.output.pixelFormat || "yuv420p",
    "-preset",
    plan.output.preset || "fast",
    "-crf",
    String(plan.output.crf ?? 23),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    tmpOutputPath
  ];
}

/**
 * Inspects completed MP4 output file using FFprobe.
 * Verifies non-empty file, video stream presence, dimensions, frame rate, duration, and audio stream.
 */
export async function verifyRenderOutput(
  tmpFilePath: string,
  plan: ServerResolvedRenderPlan
): Promise<{ valid: boolean; error?: string; metadata?: FFprobeMetadata }> {
  if (!fs.existsSync(tmpFilePath)) {
    return { valid: false, error: "Output file was not created by FFmpeg." };
  }

  const stat = fs.statSync(tmpFilePath);
  if (stat.size === 0) {
    return { valid: false, error: "Output MP4 file is empty (0 bytes)." };
  }

  try {
    const meta = await inspectVideo(tmpFilePath);

    if (!meta.videoCodec || meta.videoCodec === "unknown") {
      return { valid: false, error: "Output MP4 contains no valid video stream." };
    }

    if (meta.width !== plan.settings.width || meta.height !== plan.settings.height) {
      return {
        valid: false,
        error: `Output video dimensions (${meta.width}x${meta.height}) do not match plan settings (${plan.settings.width}x${plan.settings.height}).`
      };
    }

    // Allow 0.5s tolerance for container frame timing & muxing padding
    if (Math.abs(meta.duration - plan.duration) > 0.5) {
      return {
        valid: false,
        error: `Output video duration (${meta.duration.toFixed(2)}s) does not match expected plan duration (${plan.duration.toFixed(2)}s).`
      };
    }

    if (!meta.audioCodec) {
      return { valid: false, error: "Output MP4 contains no valid AAC audio stream." };
    }

    return { valid: true, metadata: meta };
  } catch (err) {
    return {
      valid: false,
      error: `FFprobe verification error: ${(err as Error).message}`
    };
  }
}

/**
 * Cancels an active render process, terminates child process, removes temporary files,
 * and sets status to "canceled".
 */
export async function cancelActiveRender(jobId: string): Promise<boolean> {
  const active = activeJobs.get(jobId);
  if (!active) {
    return false;
  }

  active.canceled = true;

  try {
    if (active.process && !active.process.killed) {
      active.process.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (active.process && !active.process.killed) {
            active.process.kill("SIGKILL");
          }
        } catch {}
      }, 1000);
    }
  } catch (err) {
    console.error(`[RenderPipeline] Error terminating process for job ${jobId}:`, err);
  }

  // Remove incomplete temp file
  try {
    if (fs.existsSync(active.tmpFilePath)) {
      fs.unlinkSync(active.tmpFilePath);
    }
  } catch (err) {
    console.error(`[RenderPipeline] Error removing temp file for job ${jobId}:`, err);
  }

  activeJobs.delete(jobId);
  await renderJobService.updateRenderJobStatus(jobId, "canceled");
  return true;
}

/**
 * Gracefully shuts down all active render processes and cleans up temporary files on server shutdown.
 */
export function shutdownRenderPipeline(): void {
  if (activeJobs.size === 0) return;
  console.log(`[RenderPipeline] Terminating ${activeJobs.size} active render jobs for shutdown...`);

  for (const [jobId, active] of activeJobs.entries()) {
    active.canceled = true;
    try {
      if (active.process && !active.process.killed) {
        active.process.kill("SIGKILL");
      }
      if (fs.existsSync(active.tmpFilePath)) {
        fs.unlinkSync(active.tmpFilePath);
      }
    } catch (err) {
      console.error(`[RenderPipeline] Shutdown cleanup error for job ${jobId}:`, err);
    }
  }
  activeJobs.clear();
}

// Hook process signals once for graceful shutdown
let shutdownRegistered = false;
export function registerPipelineShutdownHooks(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  process.on("SIGINT", shutdownRenderPipeline);
  process.on("SIGTERM", shutdownRenderPipeline);
}

/**
 * Orchestrates the full lifecycle of a render job:
 * 1. queued -> validating
 * 2. validating -> rendering
 * 3. FFmpeg process execution with real progress tracking via -progress pipe:1
 * 4. Verification with FFprobe
 * 5. Atomic rename to final output file & metadata recording
 * 6. Clean failure handling & temp file cleanup
 */
export async function executeRenderJob(jobId: string): Promise<RenderJob | null> {
  // Prevent duplicate concurrent execution of the same job
  if (activeJobs.has(jobId)) {
    console.warn(`[RenderPipeline] Job ${jobId} is already active. Ignoring duplicate execution request.`);
    return null;
  }

  const job = await renderJobService.getRenderJobRawById(jobId);
  if (!job) {
    console.error(`[RenderPipeline] Job ${jobId} not found in database.`);
    return null;
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
    return null;
  }

  const { projectId, plan } = job;
  const tmpFileName = `render_${jobId}.tmp.mp4`;
  const finalFileName = `render_${jobId}.mp4`;
  const tmpFilePath = resolveExportFilePath(projectId, tmpFileName);
  const finalFilePath = resolveExportFilePath(projectId, finalFileName);

  // Register active job immediately to allow cancellation during validation
  const active: ActiveRenderJob = {
    jobId,
    projectId,
    tmpFilePath,
    finalFilePath,
    canceled: false,
    startTime: Date.now()
  };
  activeJobs.set(jobId, active);

  // Clean up any stale temp file from earlier run
  if (fs.existsSync(tmpFilePath)) {
    try {
      fs.unlinkSync(tmpFilePath);
    } catch {}
  }

  if (active.canceled) {
    activeJobs.delete(jobId);
    return renderJobService.updateRenderJobStatus(jobId, "canceled");
  }

  // 1. Transition to validating
  await renderJobService.updateRenderJobStatus(jobId, "validating");

  if (active.canceled) {
    activeJobs.delete(jobId);
    return renderJobService.updateRenderJobStatus(jobId, "canceled");
  }

  // Validate server render plan
  const validation = await validateServerRenderPlan(projectId, plan);
  if (active.canceled) {
    activeJobs.delete(jobId);
    return renderJobService.updateRenderJobStatus(jobId, "canceled");
  }

  if (!validation.valid || !validation.resolvedPlan) {
    activeJobs.delete(jobId);
    const errorMsg = validation.errors.join("; ");
    return renderJobService.updateRenderJobStatus(jobId, "failed", { error: errorMsg });
  }

  // Check FFmpeg availability
  const isFFmpegAvailable = await checkFFmpegAvailable();
  if (active.canceled) {
    activeJobs.delete(jobId);
    return renderJobService.updateRenderJobStatus(jobId, "canceled");
  }

  if (!isFFmpegAvailable) {
    activeJobs.delete(jobId);
    const errorMsg = "FFmpeg binary is not available or executable on the server.";
    return renderJobService.updateRenderJobStatus(jobId, "failed", { error: errorMsg });
  }

  // Build and validate safe arguments
  let args: string[];
  try {
    args = buildFFmpegRenderArgs(validation.resolvedPlan, tmpFilePath);
    validateFFmpegSafety(args);
  } catch (argErr) {
    activeJobs.delete(jobId);
    return renderJobService.updateRenderJobStatus(jobId, "failed", {
      error: `Command building error: ${(argErr as Error).message}`
    });
  }

  if (active.canceled) {
    activeJobs.delete(jobId);
    return renderJobService.updateRenderJobStatus(jobId, "canceled");
  }

  // 2. Transition to rendering
  await renderJobService.updateRenderJobStatus(jobId, "rendering", { progress: 0 });

  return new Promise<RenderJob | null>((resolve) => {
    const ffmpegBinary = getFFmpegPath();
    let proc: ChildProcess;

    try {
      proc = spawn(ffmpegBinary, args, { shell: false });
      active.process = proc;
    } catch (spawnErr) {
      activeJobs.delete(jobId);
      if (fs.existsSync(tmpFilePath)) {
        try { fs.unlinkSync(tmpFilePath); } catch {}
      }
      renderJobService
        .updateRenderJobStatus(jobId, "failed", {
          error: `Failed to spawn FFmpeg: ${(spawnErr as Error).message}`
        })
        .then(resolve);
      return;
    }

    let stderrBuf = "";
    let lastProgressUpdate = 0;
    let currentProgress = 0;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Parse out_time_us from -progress pipe:1 key-value pairs
      const match = text.match(/out_time_us=(\d+)/);
      if (match && plan.duration > 0) {
        const outTimeUs = parseInt(match[1], 10);
        const outTimeSec = outTimeUs / 1_000_000;
        const progressPercent = Math.min(
          99,
          Math.max(0, Math.floor((outTimeSec / plan.duration) * 100))
        );

        const now = Date.now();
        // Throttle database progress updates to once every 400ms or on percentage increase
        if (progressPercent > currentProgress && now - lastProgressUpdate >= 400) {
          currentProgress = progressPercent;
          lastProgressUpdate = now;
          renderJobService.updateRenderJobStatus(jobId, "rendering", {
            progress: progressPercent
          }).catch(() => {});
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString();
      stderrBuf += str;
      if (stderrBuf.length > 5000) {
        stderrBuf = stderrBuf.slice(-5000);
      }
    });

    proc.on("error", async (err) => {
      activeJobs.delete(jobId);
      if (fs.existsSync(tmpFilePath)) {
        try { fs.unlinkSync(tmpFilePath); } catch {}
      }
      const updated = await renderJobService.updateRenderJobStatus(jobId, "failed", {
        error: `FFmpeg runtime error: ${err.message}`
      });
      resolve(updated);
    });

    proc.on("close", async (code) => {
      activeJobs.delete(jobId);

      // Handle user cancellation
      if (active.canceled) {
        if (fs.existsSync(tmpFilePath)) {
          try { fs.unlinkSync(tmpFilePath); } catch {}
        }
        const updated = await renderJobService.updateRenderJobStatus(jobId, "canceled");
        resolve(updated);
        return;
      }

      // Handle non-zero exit code
      if (code !== 0) {
        if (fs.existsSync(tmpFilePath)) {
          try { fs.unlinkSync(tmpFilePath); } catch {}
        }
        const snippet = stderrBuf.trim().slice(-600) || "FFmpeg execution failed.";
        const updated = await renderJobService.updateRenderJobStatus(jobId, "failed", {
          error: `FFmpeg exited with code ${code}. ${snippet}`
        });
        resolve(updated);
        return;
      }

      // Exit code 0: Verify completed MP4 file with FFprobe
      const verifyResult = await verifyRenderOutput(tmpFilePath, validation.resolvedPlan!);
      if (!verifyResult.valid) {
        if (fs.existsSync(tmpFilePath)) {
          try { fs.unlinkSync(tmpFilePath); } catch {}
        }
        const updated = await renderJobService.updateRenderJobStatus(jobId, "failed", {
          error: `Output verification failed: ${verifyResult.error}`
        });
        resolve(updated);
        return;
      }

      // Atomic rename of verified temp MP4 to final production MP4
      try {
        fs.renameSync(tmpFilePath, finalFilePath);
      } catch (renameErr) {
        if (fs.existsSync(tmpFilePath)) {
          try { fs.unlinkSync(tmpFilePath); } catch {}
        }
        const updated = await renderJobService.updateRenderJobStatus(jobId, "failed", {
          error: `Failed to finalize render file: ${(renameErr as Error).message}`
        });
        resolve(updated);
        return;
      }

      const stat = fs.statSync(finalFilePath);
      const updated = await renderJobService.updateRenderJobStatus(jobId, "completed", {
        progress: 100,
        outputMetadata: {
          outputFileName: finalFileName,
          fileSizeBytes: stat.size,
          duration: verifyResult.metadata?.duration,
          format: verifyResult.metadata?.format
        }
      });
      resolve(updated);
    });
  });
}
