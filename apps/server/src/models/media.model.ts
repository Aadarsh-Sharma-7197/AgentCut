import { ObjectId } from "mongodb";
import type { MediaAsset } from "@agentcut/shared";

export interface MediaAssetDocument {
  _id: ObjectId;
  projectId: string;
  originalName: string;
  storedFileName: string;
  fileSize: number;
  mimeType: string;
  duration: number;
  width: number;
  height: number;
  frameRate: string;
  videoCodec: string;
  audioCodec: string | null;
  format: string;
  createdAt: Date;
}

export function toMediaAssetDTO(doc: MediaAssetDocument): MediaAsset {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId,
    originalName: doc.originalName,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    duration: doc.duration,
    width: doc.width,
    height: doc.height,
    frameRate: doc.frameRate,
    videoCodec: doc.videoCodec,
    audioCodec: doc.audioCodec,
    format: doc.format,
    createdAt: doc.createdAt.toISOString()
  };
}

