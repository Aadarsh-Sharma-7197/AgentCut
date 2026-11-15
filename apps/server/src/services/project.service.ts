import { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import { ProjectDocument, toProjectDTO } from "../models/project.model.js";
import { deleteMediaAssetsByProject } from "./media.service.js";
import { deleteTimelineByProject } from "./timeline.service.js";
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
 * POLICY ENFORCEMENT: Deletion removes ONLY the MongoDB project, associated media, and timeline metadata records.
 * It NEVER deletes original media files, directories, user files, or performs filesystem cleanup.
 */
export async function deleteProject(id: string): Promise<boolean> {
  const collection = getCollection();
  const result = await collection.deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 1) {
    // Remove associated media asset metadata from MongoDB, leaving disk untouched
    await deleteMediaAssetsByProject(id);
    // Remove associated timeline metadata from MongoDB, leaving disk untouched
    await deleteTimelineByProject(id);
    return true;
  }
  return false;
}

