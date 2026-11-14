import { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import { MediaAssetDocument, toMediaAssetDTO } from "../models/media.model.js";
import type { MediaAsset } from "@agentcut/shared";

const COLLECTION_NAME = "media_assets";

function getCollection(): Collection<MediaAssetDocument> {
  return getDB().collection<MediaAssetDocument>(COLLECTION_NAME);
}

export async function initMediaIndexes(): Promise<void> {
  try {
    const col = getCollection();
    await col.createIndex({ projectId: 1 });
    await col.createIndex({ createdAt: -1 });
  } catch (err) {
    console.error("[MediaService] Error creating indexes:", err);
  }
}

export async function createMediaAsset(
  data: Omit<MediaAssetDocument, "_id" | "createdAt">
): Promise<MediaAsset> {
  const collection = getCollection();
  const now = new Date();

  const docToInsert: Omit<MediaAssetDocument, "_id"> = {
    ...data,
    createdAt: now
  };

  const result = await collection.insertOne(docToInsert as MediaAssetDocument);
  const createdDoc: MediaAssetDocument = {
    _id: result.insertedId,
    ...docToInsert
  };

  return toMediaAssetDTO(createdDoc);
}

export async function getMediaAssetsByProject(projectId: string): Promise<MediaAsset[]> {
  const collection = getCollection();
  const docs = await collection
    .find({ projectId })
    .sort({ createdAt: -1 })
    .toArray();

  return docs.map(toMediaAssetDTO);
}

export async function getMediaAssetById(
  projectId: string,
  assetId: string
): Promise<{ asset: MediaAsset; storedFileName: string; mimeType: string; fileSize: number } | null> {
  if (!ObjectId.isValid(assetId)) {
    return null;
  }

  const collection = getCollection();
  const doc = await collection.findOne({
    _id: new ObjectId(assetId),
    projectId
  });

  if (!doc) {
    return null;
  }

  return {
    asset: toMediaAssetDTO(doc),
    storedFileName: doc.storedFileName,
    mimeType: doc.mimeType,
    fileSize: doc.fileSize
  };
}

/**
 * Deletes all media asset metadata records associated with a project.
 * POLICY ENFORCEMENT: Deletion removes ONLY MongoDB metadata records.
 * It NEVER deletes physical media files or directories on the filesystem.
 */
export async function deleteMediaAssetsByProject(projectId: string): Promise<number> {
  const collection = getCollection();
  const result = await collection.deleteMany({ projectId });
  return result.deletedCount;
}

