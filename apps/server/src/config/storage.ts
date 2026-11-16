import path from "path";
import os from "os";
import fs from "fs";

export const SUPPORTED_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"] as const;

export function getDataDir(): string {
  const configured = process.env.AGENTCUT_DATA_DIR;
  if (!configured) {
    return path.join(os.homedir(), ".agentcut");
  }

  if (configured.startsWith("~")) {
    return path.join(os.homedir(), configured.slice(1));
  }

  return path.resolve(configured);
}

export function getMaxUploadSizeBytes(): number {
  const envVal = process.env.MAX_UPLOAD_SIZE_BYTES;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 2 * 1024 * 1024 * 1024; // 2 GB default
}

export function getProjectMediaDir(projectId: string): string {
  const root = getDataDir();
  const projectMediaDir = path.join(root, "projects", projectId, "media");

  // Prevent path traversal on projectId
  const resolved = path.resolve(projectMediaDir);
  const expectedPrefix = path.resolve(root, "projects");
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error("Invalid project ID path.");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

export function resolveStoredFilePath(projectId: string, storedFileName: string): string {
  const mediaDir = getProjectMediaDir(projectId);
  const resolved = path.resolve(mediaDir, storedFileName);

  // Path traversal defense
  if (!resolved.startsWith(mediaDir + path.sep) && resolved !== mediaDir) {
    throw new Error("Invalid file path: path traversal detected.");
  }

  return resolved;
}

export function getProjectExportDir(projectId: string): string {
  const root = getDataDir();
  const projectExportDir = path.join(root, "projects", projectId, "exports");

  // Prevent path traversal on projectId
  const resolved = path.resolve(projectExportDir);
  const expectedPrefix = path.resolve(root, "projects");
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error("Invalid project ID path.");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

export function resolveExportFilePath(projectId: string, fileName: string): string {
  const exportDir = getProjectExportDir(projectId);
  const resolved = path.resolve(exportDir, fileName);

  // Path traversal defense
  if (!resolved.startsWith(exportDir + path.sep) && resolved !== exportDir) {
    throw new Error("Invalid export file path: path traversal detected.");
  }

  return resolved;
}

export function getProjectAnalysisDir(projectId: string): string {
  const root = getDataDir();
  const projectAnalysisDir = path.join(root, "projects", projectId, "analysis");

  // Prevent path traversal on projectId
  const resolved = path.resolve(projectAnalysisDir);
  const expectedPrefix = path.resolve(root, "projects");
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error("Invalid project ID path.");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

export function getAssetAnalysisDir(projectId: string, assetId: string): string {
  const analysisDir = getProjectAnalysisDir(projectId);
  const assetDir = path.join(analysisDir, assetId);

  // Prevent path traversal on assetId
  const resolved = path.resolve(assetDir);
  if (!resolved.startsWith(analysisDir + path.sep) && resolved !== analysisDir) {
    throw new Error("Invalid asset ID path: path traversal detected.");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

export function resolveAssetAnalysisAudioPath(projectId: string, assetId: string): string {
  const assetDir = getAssetAnalysisDir(projectId, assetId);
  const resolved = path.resolve(assetDir, "audio.wav");

  if (!resolved.startsWith(assetDir + path.sep)) {
    throw new Error("Invalid audio path: path traversal detected.");
  }

  return resolved;
}

export function resolveAssetAnalysisTempAudioPath(projectId: string, assetId: string): string {
  const assetDir = getAssetAnalysisDir(projectId, assetId);
  const resolved = path.resolve(assetDir, "audio.tmp.wav");

  if (!resolved.startsWith(assetDir + path.sep)) {
    throw new Error("Invalid temp audio path: path traversal detected.");
  }

  return resolved;
}

export function getWhisperModelsDir(): string {
  const configured = process.env.WHISPER_MODELS_DIR || process.env.AGENTCUT_MODELS_DIR;
  if (configured) {
    return path.resolve(configured);
  }
  const root = getDataDir();
  const modelsDir = path.join(root, "models", "whisper");
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  return modelsDir;
}

export function getAssetTranscriptionDir(projectId: string, assetId: string): string {
  const assetDir = getAssetAnalysisDir(projectId, assetId);
  const transcriptionDir = path.join(assetDir, "transcription");
  const resolved = path.resolve(transcriptionDir);

  if (!resolved.startsWith(assetDir + path.sep)) {
    throw new Error("Invalid transcription path: path traversal detected.");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

export function resolveAssetTranscriptPath(projectId: string, assetId: string): string {
  const transcriptionDir = getAssetTranscriptionDir(projectId, assetId);
  const resolved = path.resolve(transcriptionDir, "transcript.json");

  if (!resolved.startsWith(transcriptionDir + path.sep)) {
    throw new Error("Invalid transcript path: path traversal detected.");
  }

  return resolved;
}

export function resolveAssetTranscriptTempPath(projectId: string, assetId: string, jobId: string): string {
  const transcriptionDir = getAssetTranscriptionDir(projectId, assetId);
  const resolved = path.resolve(transcriptionDir, `transcript.${jobId}.tmp.json`);

  if (!resolved.startsWith(transcriptionDir + path.sep)) {
    throw new Error("Invalid temp transcript path: path traversal detected.");
  }

  return resolved;
}

export function getAssetScenesDir(projectId: string, assetId: string): string {
  const assetDir = getAssetAnalysisDir(projectId, assetId);
  const scenesDir = path.join(assetDir, "scenes");
  const resolved = path.resolve(scenesDir);

  if (!resolved.startsWith(assetDir + path.sep)) {
    throw new Error("Invalid scenes dir path: path traversal detected.");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

export function getSceneAnalysisDir(projectId: string, assetId: string, analysisId: string): string {
  const scenesDir = getAssetScenesDir(projectId, assetId);
  const analysisDir = path.join(scenesDir, analysisId);
  const resolved = path.resolve(analysisDir);

  if (!resolved.startsWith(scenesDir + path.sep)) {
    throw new Error("Invalid scene analysis dir path: path traversal detected.");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

export function resolveSceneFramePath(
  projectId: string,
  assetId: string,
  analysisId: string,
  sceneId: string
): string {
  const analysisDir = getSceneAnalysisDir(projectId, assetId, analysisId);
  const resolved = path.resolve(analysisDir, `${sceneId}.jpg`);

  if (!resolved.startsWith(analysisDir + path.sep)) {
    throw new Error("Invalid scene frame path: path traversal detected.");
  }

  return resolved;
}

export function resolveSceneFrameTempPath(
  projectId: string,
  assetId: string,
  analysisId: string,
  sceneId: string,
  jobId: string
): string {
  const analysisDir = getSceneAnalysisDir(projectId, assetId, analysisId);
  const resolved = path.resolve(analysisDir, `${sceneId}.${jobId}.tmp.jpg`);

  if (!resolved.startsWith(analysisDir + path.sep)) {
    throw new Error("Invalid temp scene frame path: path traversal detected.");
  }

  return resolved;
}

