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

