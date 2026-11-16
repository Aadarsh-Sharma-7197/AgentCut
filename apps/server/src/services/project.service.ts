import { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import { ProjectDocument, toProjectDTO } from "../models/project.model.js";
import { deleteMediaAssetsByProject } from "./media.service.js";
import { deleteTimelineByProject } from "./timeline.service.js";
import { deleteRenderJobsByProject } from "./render-job.service.js";
import { deleteAudioExtractionsByProject } from "./audio-extraction.service.js";
import { deleteSilenceDetectionsByProject } from "./silence-detection.service.js";
import { deleteTranscriptionsByProject } from "./transcription.service.js";
import type { Project } from "@agentcut/shared";

const COLLECTION_NAME = "projects";

function getCollection(): Collection<ProjectDocument> {
  return getDB().collection<ProjectDocument>(COLLECTION_NAME);
}

export async function createProject(name: string): Promise<Project> {
  const collection = getCollection();
  const now = new Date();

  const newDoc: Omit<ProjectDocument, "_id"> = {
    name: name.trim(),
    createdAt: now,
    updatedAt: now
  };

  const result = await collection.insertOne(newDoc as ProjectDocument);
  const createdDoc: ProjectDocument = {
    _id: result.insertedId,
    ...newDoc
  };

  return toProjectDTO(createdDoc);
}

export async function getAllProjects(): Promise<Project[]> {
  const collection = getCollection();
  const docs = await collection
    .find()
    .sort({ updatedAt: -1 })
    .toArray();

  return docs.map(toProjectDTO);
}

export async function getProjectById(id: string): Promise<Project | null> {
  const collection = getCollection();
  const doc = await collection.findOne({ _id: new ObjectId(id) });
  if (!doc) {
    return null;
  }
  return toProjectDTO(doc);
}

/**
 * Deletes a project.
 * POLICY ENFORCEMENT: Deletion removes ONLY the MongoDB project, associated media, timeline, render-job, audio-extraction, and silence-detection metadata records.
 * It NEVER deletes original media files, directories, user files, or performs filesystem cleanup.
 */
export async function deleteProject(id: string): Promise<boolean> {
  const collection = getCollection();
  const result = await collection.deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 1) {
    try {
      // Cascading metadata cleanup in parallel across all associated collections
      await Promise.all([
        deleteMediaAssetsByProject(id),
        deleteTimelineByProject(id),
        deleteRenderJobsByProject(id),
        deleteAudioExtractionsByProject(id),
        deleteSilenceDetectionsByProject(id),
        deleteTranscriptionsByProject(id)
      ]);
    } catch (err) {
      console.error(`[ProjectService] Warning: Sub-collection cleanup failed after deleting project '${id}':`, err);
      throw err;
    }
    return true;
  }
  return false;
}


