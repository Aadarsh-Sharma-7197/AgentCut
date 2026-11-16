import fs from "fs";
import {
  type RenderPlan,
  type RenderClip,
  type RenderPlanValidationResult,
  validateRenderPlan as validateDomainRenderPlan
} from "@agentcut/shared";
import * as mediaService from "./media.service.js";
import { resolveStoredFilePath } from "../config/storage.js";

export interface ServerRenderClip extends RenderClip {
  resolvedFilePath: string;
}

export interface ServerResolvedRenderPlan extends Omit<RenderPlan, "videoClips" | "audioClips"> {
  videoClips: ServerRenderClip[];
  audioClips: ServerRenderClip[];
}

export interface ServerRenderValidationResult extends RenderPlanValidationResult {
  resolvedPlan?: ServerResolvedRenderPlan;
}

/**
 * Validates a RenderPlan against server-side database records, permissions, and filesystem media files.
 * Ensures:
 * - Domain validation passes.
 * - Every referenced media asset exists in the project.
 * - Cross-project asset references are rejected.
 * - Required media streams are present (e.g. video clips have videoCodec).
 * - Physical media files exist on disk and have non-zero file size.
 * - Clip source boundaries do not exceed the actual media duration.
 */
export async function validateServerRenderPlan(
  projectId: string,
  plan: RenderPlan
): Promise<ServerRenderValidationResult> {
  // 1. Run pure domain validation first
  const domainValidation = validateDomainRenderPlan(plan);
  const errors = [...domainValidation.errors];
  const warnings = [...domainValidation.warnings];

  if (plan.projectId !== projectId) {
    errors.push(`Render plan projectId ('${plan.projectId}') does not match target project ('${projectId}').`);
  }

  // 2. Fetch all media assets for the project from the database
  const projectAssets = await mediaService.getMediaAssetsByProject(projectId);
  const assetMap = new Map(projectAssets.map((a) => [a.id, a]));

  const resolvedVideoClips: ServerRenderClip[] = [];
  const resolvedAudioClips: ServerRenderClip[] = [];

  // Helper to validate and resolve a render clip
  const validateAndResolveClip = async (
    clip: RenderClip,
    expectedStreamType: "video" | "audio"
  ): Promise<ServerRenderClip | null> => {
    const asset = assetMap.get(clip.assetId);

    // Asset existence & project ownership
    if (!asset) {
      // Check if it exists under another project (cross-project hijacking detection)
      const foreignAssetDoc = await mediaService.getMediaAssetById("any", clip.assetId).catch(() => null);
      if (foreignAssetDoc) {
        errors.push(
          `Clip '${clip.clipId}' references asset '${clip.assetId}' which belongs to another project. Cross-project media access is forbidden.`
        );
      } else {
        errors.push(
          `Clip '${clip.clipId}' references asset '${clip.assetId}' which does not exist in project '${projectId}'.`
        );
      }
      return null;
    }

    // Required media stream check
    if (expectedStreamType === "video" && (!asset.videoCodec || asset.videoCodec.trim() === "")) {
      errors.push(
        `Clip '${clip.clipId}' is placed on a video track, but asset '${asset.originalName}' has no video stream (codec: ${asset.videoCodec}).`
      );
    }
    if (expectedStreamType === "audio" && (!asset.audioCodec || asset.audioCodec.trim() === "")) {
      errors.push(
        `Clip '${clip.clipId}' is placed on an audio track, but asset '${asset.originalName}' has no audio stream.`
      );
    }

    // Physical file existence on disk
    let resolvedFilePath = "";
    try {
      const assetDetail = await mediaService.getMediaAssetById(projectId, clip.assetId);
      if (!assetDetail) {
        errors.push(`Failed to retrieve media file record for asset '${clip.assetId}'.`);
        return null;
      }

      resolvedFilePath = resolveStoredFilePath(projectId, assetDetail.storedFileName);
      if (!fs.existsSync(resolvedFilePath)) {
        errors.push(
          `Physical media file for asset '${asset.originalName}' is missing on disk (expected: ${assetDetail.storedFileName}).`
        );
        return null;
      }

      const fileStat = fs.statSync(resolvedFilePath);
      if (fileStat.size === 0) {
        errors.push(
          `Physical media file for asset '${asset.originalName}' is corrupted or empty (0 bytes).`
        );
        return null;
      }
    } catch (err) {
      errors.push(`Filesystem resolution error for asset '${clip.assetId}': ${(err as Error).message}`);
      return null;
    }

    // Source boundaries check against asset duration
    // Allow small 0.05s tolerance for container metadata timestamp rounding
    if (asset.duration && clip.sourceEnd > asset.duration + 0.05) {
      errors.push(
        `Clip '${clip.clipId}' sourceEnd (${clip.sourceEnd}s) exceeds actual media duration (${asset.duration.toFixed(2)}s) for asset '${asset.originalName}'.`
      );
    }

    return {
      ...clip,
      resolvedFilePath
    };
  };

  // Validate all video clips
  for (const clip of plan.videoClips) {
    const resolved = await validateAndResolveClip(clip, "video");
    if (resolved) {
      resolvedVideoClips.push(resolved);
    }
  }

  // Validate all audio clips
  for (const clip of plan.audioClips) {
    const resolved = await validateAndResolveClip(clip, "audio");
    if (resolved) {
      resolvedAudioClips.push(resolved);
    }
  }

  const isValid = errors.length === 0;

  let resolvedPlan: ServerResolvedRenderPlan | undefined;
  if (isValid) {
    resolvedPlan = {
      ...plan,
      videoClips: resolvedVideoClips,
      audioClips: resolvedAudioClips
    };
  }

  return {
    valid: isValid,
    errors,
    warnings,
    resolvedPlan
  };
}

