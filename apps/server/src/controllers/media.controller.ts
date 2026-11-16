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


