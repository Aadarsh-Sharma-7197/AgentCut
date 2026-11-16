import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  uploadMiddleware,
  uploadMediaHandler,
  getMediaListHandler,
  getMediaAssetHandler,
  streamMediaHandler,
  requestAudioExtractionHandler,
  getAudioExtractionHandler,
  streamAudioExtractionHandler,
  detectSilenceHandler,
  getSilenceDetectionHandler,
  requestTranscriptionHandler,
  getTranscriptionHandler,
  cancelTranscriptionHandler,
  requestSceneDetectionHandler,
  getSceneDetectionHandler,
  cancelSceneDetectionHandler,
  getSceneFrameHandler
} from "../controllers/media.controller.js";

export const mediaRouter = Router({ mergeParams: true });

// Custom wrapper to cleanly catch multer validation errors (size limit, unsupported extension) as 400 Bad Request
function handleUpload(req: Request, res: Response, next: NextFunction) {
  uploadMiddleware.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File exceeds the maximum upload size limit." });
      }
      return res.status(400).json({ error: err.message });
    } else if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}

mediaRouter.post("/", handleUpload, uploadMediaHandler);
mediaRouter.get("/", getMediaListHandler);
mediaRouter.get("/:assetId", getMediaAssetHandler);
mediaRouter.get("/:assetId/stream", streamMediaHandler);

// Audio extraction routes
mediaRouter.post("/:assetId/extract-audio", requestAudioExtractionHandler);
mediaRouter.post("/:assetId/audio/extract", requestAudioExtractionHandler);
mediaRouter.post("/:assetId/audio", requestAudioExtractionHandler);
mediaRouter.get("/:assetId/audio", getAudioExtractionHandler);
mediaRouter.get("/:assetId/audio/stream", streamAudioExtractionHandler);

// Silence detection routes
mediaRouter.post("/:assetId/silence/detect", detectSilenceHandler);
mediaRouter.post("/:assetId/silence", detectSilenceHandler);
mediaRouter.post("/:assetId/detect-silence", detectSilenceHandler);
mediaRouter.get("/:assetId/silence", getSilenceDetectionHandler);
mediaRouter.get("/:assetId/silence/status", getSilenceDetectionHandler);

// Multilingual transcription routes
mediaRouter.post("/:assetId/transcription", requestTranscriptionHandler);
mediaRouter.post("/:assetId/transcribe", requestTranscriptionHandler);
mediaRouter.get("/:assetId/transcription", getTranscriptionHandler);
mediaRouter.get("/:assetId/transcription/:transcriptionId", getTranscriptionHandler);
mediaRouter.post("/:assetId/transcription/cancel", cancelTranscriptionHandler);
mediaRouter.post("/:assetId/transcription/:transcriptionId/cancel", cancelTranscriptionHandler);

// Scene detection routes
mediaRouter.post("/:assetId/scenes", requestSceneDetectionHandler);
mediaRouter.post("/:assetId/scenes/detect", requestSceneDetectionHandler);
mediaRouter.post("/:assetId/detect-scenes", requestSceneDetectionHandler);
mediaRouter.get("/:assetId/scenes", getSceneDetectionHandler);
mediaRouter.get("/:assetId/scenes/analyses/:analysisId", getSceneDetectionHandler);
mediaRouter.post("/:assetId/scenes/cancel", cancelSceneDetectionHandler);
mediaRouter.get("/:assetId/scenes/analyses/:analysisId/frames/:sceneId", getSceneFrameHandler);
mediaRouter.get("/:assetId/scenes/frames/:sceneId", getSceneFrameHandler);
