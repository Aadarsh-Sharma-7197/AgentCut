import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import multer from "multer";
import {
  getProjectMediaDir,
  resolveStoredFilePath,
  getMaxUploadSizeBytes,
  SUPPORTED_EXTENSIONS
} from "../config/storage.js";
import { inspectVideo } from "../utils/ffprobe.js";
import * as projectService from "../services/project.service.js";
import * as mediaService from "../services/media.service.js";
import * as audioExtractionService from "../services/audio-extraction.service.js";
import * as silenceDetectionService from "../services/silence-detection.service.js";
import * as transcriptionService from "../services/transcription.service.js";
import * as sceneDetectionService from "../services/scene-detection.service.js";
import * as mediaIntelligenceService from "../services/media-intelligence.service.js";
import * as mediaIndexService from "../services/media-index.service.js";
import { SearchError } from "../services/media-index.service.js";
import { resolveAssetAnalysisAudioPath } from "../config/storage.js";

// Multer storage engine to save files directly into the project's media folder with a UUID
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const { projectId } = req.params;
    if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
      return cb(new Error("Invalid project ID format."), "");
    }
    try {
      const dir = getProjectMediaDir(projectId);
      cb(null, dir);
    } catch (err) {
      cb(err instanceof Error ? err : new Error("Could not access project media directory."), "");
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${randomUUID()}${ext}`;
    cb(null, uniqueName);
  }
});

export const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: getMaxUploadSizeBytes()
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext as (typeof SUPPORTED_EXTENSIONS)[number])) {
      return cb(
        new Error(
          `Unsupported file extension: '${ext}'. Supported video formats are: ${SUPPORTED_EXTENSIONS.join(", ")}`
        )
      );
    }
    cb(null, true);
  }
});

export async function uploadMediaHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  // Validate that the project exists
  const project = await projectService.getProjectById(projectId);
  if (!project) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch {}
    }
    res.status(404).json({ error: "Project not found." });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No video file provided." });
    return;
  }

  const uploadedFilePath = req.file.path;
  const storedFileName = req.file.filename;

  try {
    // Validate video stream and extract metadata using FFprobe
    const metadata = await inspectVideo(uploadedFilePath);

    const asset = await mediaService.createMediaAsset({
      projectId,
      originalName: req.file.originalname,
      storedFileName,
      fileSize: metadata.fileSize || req.file.size,
      mimeType: req.file.mimetype || "video/mp4",
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      frameRate: metadata.frameRate,
      videoCodec: metadata.videoCodec,
      audioCodec: metadata.audioCodec,
      format: metadata.format
    });

    res.status(201).json({ data: asset });
  } catch (err: unknown) {
    // If FFprobe inspection fails or file is invalid, clean up incomplete upload immediately
    if (fs.existsSync(uploadedFilePath)) {
      try {
        await fs.promises.unlink(uploadedFilePath);
      } catch (cleanupErr) {
        console.error("[MediaController] Failed to clean up rejected file:", cleanupErr);
      }
    }

    const message = err instanceof Error ? err.message : "Media inspection failed.";
    res.status(400).json({ error: message });
  }
}

export async function getMediaListHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    const assets = await mediaService.getMediaAssetsByProject(projectId);
    res.status(200).json({ data: assets });
  } catch (err) {
    console.error("[MediaController] getMediaList error:", err);
    res.status(500).json({ error: "Failed to fetch media assets." });
  }
}

export async function getMediaAssetHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  try {
    const result = await mediaService.getMediaAssetById(projectId, assetId);
    if (!result) {
      res.status(404).json({ error: "Media asset not found in this project." });
      return;
    }

    res.status(200).json({ data: result.asset });
  } catch (err) {
    console.error("[MediaController] getMediaAsset error:", err);
    res.status(500).json({ error: "Failed to fetch media asset." });
  }
}

export async function streamMediaHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  try {
    const result = await mediaService.getMediaAssetById(projectId, assetId);
    if (!result) {
      res.status(404).json({ error: "Media asset not found in this project." });
      return;
    }

    const filePath = resolveStoredFilePath(projectId, result.storedFileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Media file not found on disk." });
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const contentType = result.mimeType || "video/mp4";

    if (range) {
      // Parse Range header e.g. "bytes=0-1000"
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || isNaN(end) || start > end || start >= fileSize || end >= fileSize) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
        res.end();
        return;
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType
      });

      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes"
      });

      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error("[MediaController] streamMedia error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream media asset." });
    }
  }
}

/**
 * Handles requesting an audio extraction for an imported media asset.
 * Validates project ownership, enforces concurrency deduplication, and runs extraction safely.
 * Never exposes server filesystem paths.
 */
export async function requestAudioExtractionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  // Check project existence
  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Check media asset existence and project ownership
  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const artifact = await audioExtractionService.requestAudioExtraction(projectId, assetId);
    res.status(200).json({ data: artifact });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Audio extraction failed.";
    if (message.includes("not found on disk")) {
      res.status(404).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
}

/**
 * Retrieves the current audio extraction metadata and status for a media asset.
 * Never exposes server filesystem paths.
 */
export async function getAudioExtractionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  // Check project existence
  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Check media asset existence and project ownership
  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const artifact = await audioExtractionService.getAudioExtraction(projectId, assetId);
    if (!artifact) {
      res.status(404).json({ error: "Audio extraction has not been performed for this media asset." });
      return;
    }

    res.status(200).json({ data: artifact });
  } catch (err: unknown) {
    console.error("[MediaController] getAudioExtraction error:", err);
    res.status(500).json({ error: "Failed to retrieve audio extraction metadata." });
  }
}

/**
 * Streams the extracted audio WAV file for preview/inspection.
 * Validates project ownership and checks that the extraction is completed.
 */
export async function streamAudioExtractionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  const artifact = await audioExtractionService.getAudioExtraction(projectId, assetId);
  if (!artifact || artifact.status !== "completed") {
    res.status(404).json({ error: "Extracted audio not found or extraction is not completed." });
    return;
  }

  try {
    const audioPath = resolveAssetAnalysisAudioPath(projectId, assetId);
    if (!fs.existsSync(audioPath)) {
      res.status(404).json({ error: "Extracted audio file not found on disk." });
      return;
    }

    const stat = fs.statSync(audioPath);
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes"
    });

    fs.createReadStream(audioPath).pipe(res);
  } catch (err: unknown) {
    console.error("[MediaController] streamAudioExtraction error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream audio file." });
    }
  }
}

/**
 * Handles requesting silence detection for a media asset using its extracted WAV artifact.
 * Validates project ownership, asset ownership, extraction prerequisite, and parameters.
 */
export async function detectSilenceHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  // Check project existence
  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Check media asset existence and project ownership
  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  const { noiseThresholdDb, minDurationSeconds } = req.body || {};

  try {
    const artifact = await silenceDetectionService.detectSilence(projectId, assetId, {
      noiseThresholdDb,
      minDurationSeconds
    });
    res.status(200).json({ data: artifact });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Silence detection failed.";
    if (
      message.includes("extract audio before") ||
      message.includes("must be a valid number") ||
      message.includes("between")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
}

/**
 * Retrieves silence detection metadata for a media asset.
 */
export async function getSilenceDetectionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const artifact = await silenceDetectionService.getSilenceDetection(projectId, assetId);
    if (!artifact) {
      res.status(404).json({ error: "Silence detection has not been performed for this media asset." });
      return;
    }

    res.status(200).json({ data: artifact });
  } catch (err: unknown) {
    console.error("[MediaController] getSilenceDetection error:", err);
    res.status(500).json({ error: "Failed to retrieve silence detection metadata." });
  }
}

/**
 * Handles requesting multilingual transcription for a media asset using its extracted WAV artifact.
 */
export async function requestTranscriptionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  const { modelName, languageHint, device, computeType } = req.body || {};

  try {
    const artifact = await transcriptionService.requestTranscription(projectId, assetId, {
      modelName,
      languageHint,
      device,
      computeType
    });
    res.status(200).json({ data: artifact });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Transcription failed.";
    if (
      message.includes("extract audio before") ||
      message.includes("Invalid modelName") ||
      message.includes("Invalid languageHint") ||
      message.includes("Invalid device")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
}

/**
 * Retrieves transcription metadata and transcript for a media asset.
 */
export async function getTranscriptionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;
  const rawTxId = req.params.transcriptionId;
  const transcriptionId = typeof rawTxId === "string" ? rawTxId : undefined;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId) ||
    (rawTxId !== undefined && (!transcriptionId || !ObjectId.isValid(transcriptionId)))
  ) {
    res.status(400).json({ error: "Invalid project ID, asset ID, or transcription ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const result = await transcriptionService.getTranscriptionWithTranscript(
      projectId,
      assetId,
      transcriptionId
    );
    if (!result) {
      res.status(404).json({ error: "Transcription not found for this media asset." });
      return;
    }

    res.status(200).json({ data: result });
  } catch (err: unknown) {
    console.error("[MediaController] getTranscription error:", err);
    res.status(500).json({ error: "Failed to retrieve transcription." });
  }
}

/**
 * Cancels an active transcription job.
 */
export async function cancelTranscriptionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;
  const rawTxId = req.params.transcriptionId;
  const transcriptionId = typeof rawTxId === "string" ? rawTxId : undefined;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId) ||
    (rawTxId !== undefined && (!transcriptionId || !ObjectId.isValid(transcriptionId)))
  ) {
    res.status(400).json({ error: "Invalid project ID, asset ID, or transcription ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const canceled = await transcriptionService.cancelTranscription(
      projectId,
      assetId,
      transcriptionId
    );
    if (!canceled) {
      res.status(404).json({ error: "No active transcription found to cancel." });
      return;
    }

    res.status(200).json({ message: "Transcription canceled successfully." });
  } catch (err: unknown) {
    console.error("[MediaController] cancelTranscription error:", err);
    res.status(500).json({ error: "Failed to cancel transcription." });
  }
}

/**
 * Handles requesting scene detection for an imported video asset.
 */
export async function requestSceneDetectionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const body = req.body || {};
    const query = req.query || {};

    const rawParams = {
      threshold: body.threshold !== undefined ? body.threshold : query.threshold,
      minSceneDuration: body.minSceneDuration !== undefined ? body.minSceneDuration : query.minSceneDuration,
      maxScenes: body.maxScenes !== undefined ? body.maxScenes : query.maxScenes
    };

    const result = await sceneDetectionService.requestSceneDetection(projectId, assetId, rawParams);
    res.status(200).json({ data: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to execute scene detection.";
    if (msg.includes("must be") || msg.includes("Invalid") || msg.includes("does not contain")) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    console.error("[MediaController] requestSceneDetection error:", err);
    res.status(500).json({ error: msg });
  }
}

/**
 * Retrieves scene detection for an asset.
 */
export async function getSceneDetectionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;
  const rawAnalysisId = req.params.analysisId || req.query.analysisId;
  const analysisId = typeof rawAnalysisId === "string" ? rawAnalysisId : undefined;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId) ||
    (analysisId !== undefined && !ObjectId.isValid(analysisId))
  ) {
    res.status(400).json({ error: "Invalid project ID, asset ID, or analysis ID format." });
    return;
  }

  try {
    const result = await sceneDetectionService.getSceneDetection(projectId, assetId, analysisId);
    if (!result) {
      res.status(404).json({ error: "Scene detection not found for this media asset." });
      return;
    }

    res.status(200).json({ data: result });
  } catch (err: unknown) {
    console.error("[MediaController] getSceneDetection error:", err);
    res.status(500).json({ error: "Failed to retrieve scene detection." });
  }
}

/**
 * Cancels an active scene detection run.
 */
export async function cancelSceneDetectionHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const canceled = await sceneDetectionService.cancelActiveSceneDetection(projectId, assetId);
    if (!canceled) {
      res.status(404).json({ error: "No active scene detection found to cancel." });
      return;
    }

    res.status(200).json({ message: "Scene detection canceled successfully." });
  } catch (err: unknown) {
    console.error("[MediaController] cancelSceneDetection error:", err);
    res.status(500).json({ error: "Failed to cancel scene detection." });
  }
}

/**
 * Streams a representative frame image with private immutable caching and strong ETag.
 */
export async function getSceneFrameHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId, sceneId } = req.params;
  const rawAnalysisId = req.params.analysisId;
  let analysisId = typeof rawAnalysisId === "string" ? rawAnalysisId : undefined;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId) ||
    typeof sceneId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(sceneId)
  ) {
    res.status(400).json({ error: "Invalid project ID, asset ID, or scene ID format." });
    return;
  }

  // If analysisId is not provided directly in URL (convenience alias route), find the latest completed analysis
  if (!analysisId) {
    const latest = await sceneDetectionService.getSceneDetection(projectId, assetId);
    if (!latest || latest.status !== "completed") {
      res.status(404).json({ error: "No completed scene detection found for this asset." });
      return;
    }
    analysisId = latest.id;
  }

  if (typeof analysisId !== "string" || !ObjectId.isValid(analysisId)) {
    res.status(400).json({ error: "Invalid analysis ID format." });
    return;
  }

  try {
    const frame = await sceneDetectionService.getSceneFrame(projectId, assetId, analysisId, sceneId);
    if (!frame) {
      res.status(404).json({ error: "Scene frame not found." });
      return;
    }

    // HTTP Caching: check If-None-Match header
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && (ifNoneMatch === frame.etag || ifNoneMatch === `W/${frame.etag}`)) {
      res.status(304).end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": frame.fileSize,
      "Cache-Control": "private, max-age=86400, immutable",
      "ETag": frame.etag
    });

    fs.createReadStream(frame.filePath).pipe(res);
  } catch (err: unknown) {
    console.error("[MediaController] getSceneFrame error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream scene frame." });
    }
  }
}

/**
 * Step 5.5: Retrieves unified media intelligence manifest.
 * Strictly read-only: performs zero database mutations.
 */
export async function getMediaIntelligenceHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const manifest = await mediaIntelligenceService.getMediaIntelligenceManifest(projectId, assetId);
    if (!manifest) {
      res.status(404).json({ error: "Media asset not found in this project." });
      return;
    }

    res.status(200).json({ data: manifest });
  } catch (err: unknown) {
    console.error("[MediaController] getMediaIntelligence error:", err);
    res.status(500).json({ error: "Failed to retrieve media intelligence manifest." });
  }
}

/**
 * Step 5.5: Retrieves sliced timeline intelligence within a bounded time window.
 * Strictly read-only: performs zero database mutations.
 */
export async function getMediaIntelligenceTimelineHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  // Parse query options
  const startParam = req.query.start !== undefined ? Number(req.query.start) : undefined;
  const endParam = req.query.end !== undefined ? Number(req.query.end) : undefined;
  const includeParam = typeof req.query.include === "string" ? req.query.include : undefined;

  try {
    const timeline = await mediaIntelligenceService.getMediaIntelligenceTimeline(projectId, assetId, {
      start: startParam,
      end: endParam,
      include: includeParam
    });

    res.status(200).json({ data: timeline });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to retrieve media intelligence timeline.";
    if (
      message.startsWith("Invalid time range:") ||
      message.startsWith("Requested timeline window exceeds") ||
      message.startsWith("Timeline query produced more than") ||
      message.startsWith("Invalid include parameter.")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    console.error("[MediaController] getMediaIntelligenceTimeline error:", err);
    res.status(500).json({ error: "Failed to retrieve media intelligence timeline." });
  }
}

/**
 * Step 5.6: Searches speech dialogue within a media asset.
 */
export async function searchAssetSpeechHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const result = await mediaIndexService.searchAssetSpeech(projectId, assetId, req.query);
    res.status(200).json({ data: result });
  } catch (err: unknown) {
    if (err instanceof SearchError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error("[MediaController] searchAssetSpeech error:", err);
    res.status(500).json({ error: "Failed to search speech dialogue." });
  }
}

/**
 * Step 5.6: Searches silence intervals within a media asset.
 */
export async function searchAssetSilenceHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const result = await mediaIndexService.searchAssetSilence(projectId, assetId, req.query);
    res.status(200).json({ data: result });
  } catch (err: unknown) {
    if (err instanceof SearchError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error("[MediaController] searchAssetSilence error:", err);
    res.status(500).json({ error: "Failed to search silence intervals." });
  }
}

/**
 * Step 5.6: Searches scene boundaries within a media asset.
 */
export async function searchAssetScenesHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const result = await mediaIndexService.searchAssetScenes(projectId, assetId, req.query);
    res.status(200).json({ data: result });
  } catch (err: unknown) {
    if (err instanceof SearchError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error("[MediaController] searchAssetScenes error:", err);
    res.status(500).json({ error: "Failed to search scene boundaries." });
  }
}

/**
 * Step 5.6: Unified asset search (speech search enriched with containing scene context).
 */
export async function searchAssetUnifiedHandler(req: Request, res: Response): Promise<void> {
  const { projectId, assetId } = req.params;

  if (
    typeof projectId !== "string" ||
    !ObjectId.isValid(projectId) ||
    typeof assetId !== "string" ||
    !ObjectId.isValid(assetId)
  ) {
    res.status(400).json({ error: "Invalid project ID or asset ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const mediaAsset = await mediaService.getMediaAssetById(projectId, assetId);
  if (!mediaAsset) {
    res.status(404).json({ error: "Media asset not found in this project." });
    return;
  }

  try {
    const result = await mediaIndexService.searchAssetUnified(projectId, assetId, req.query);
    res.status(200).json({ data: result });
  } catch (err: unknown) {
    if (err instanceof SearchError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error("[MediaController] searchAssetUnified error:", err);
    res.status(500).json({ error: "Failed to perform unified asset search." });
  }
}

/**
 * Step 5.6: Project-wide cross-asset dialogue search.
 */
export async function searchProjectIntelligenceHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  const project = await projectService.getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    const result = await mediaIndexService.searchProjectIntelligence(projectId, req.query);
    res.status(200).json({ data: result });
  } catch (err: unknown) {
    if (err instanceof SearchError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error("[MediaController] searchProjectIntelligence error:", err);
    res.status(500).json({ error: "Failed to search project dialogue." });
  }
}

