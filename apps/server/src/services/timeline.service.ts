import { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import { TimelineDocument, toTimelineDTO } from "../models/timeline.model.js";
import type { Timeline, Track, TimelineSettings } from "@agentcut/shared";

const COLLECTION_NAME = "timelines";

function getCollection(): Collection<TimelineDocument> {
  return getDB().collection<TimelineDocument>(COLLECTION_NAME);
}

export async function initTimelineIndexes(): Promise<void> {
  try {
    const col = getCollection();
    // Enforce exactly one timeline per project
    await col.createIndex({ projectId: 1 }, { unique: true });
  } catch (err) {
    console.error("[TimelineService] Error creating indexes:", err);
  }
}

export async function getTimelineByProject(projectId: string): Promise<Timeline | null> {
  const collection = getCollection();
  const doc = await collection.findOne({ projectId });
  if (!doc) {
    return null;
  }
  return toTimelineDTO(doc);
}

export interface SaveTimelineInput {
  id?: string;
  tracks: Track[];
  settings: TimelineSettings;
}

export async function saveTimeline(
  projectId: string,
  input: SaveTimelineInput
): Promise<Timeline> {
  const collection = getCollection();
  const now = new Date();
  const generatedId = input.id || new ObjectId().toHexString();

  // Atomic upsert:
  // Under concurrent updates, $setOnInsert guarantees timelineId, projectId,
  // and createdAt are only set on initial document insertion and are strictly preserved thereafter.
  // $set updates only mutable timeline state (tracks, settings, updatedAt).
  const result = await collection.findOneAndUpdate(
    { projectId },
    {
      $set: {
        tracks: input.tracks,
        settings: input.settings,
        updatedAt: now
      },
      $setOnInsert: {
        timelineId: generatedId,
        projectId,
        createdAt: now
      }
    },
    {
      upsert: true,
      returnDocument: "after"
    }
  );

  if (!result) {
    throw new Error("Failed to save timeline document.");
  }

  return toTimelineDTO(result);
}

/**
 * Deletes timeline metadata for a project.
 * POLICY ENFORCEMENT: Deletion removes ONLY the MongoDB metadata record.
 * It NEVER deletes physical media files or directories on the filesystem.
 */
export async function deleteTimelineByProject(projectId: string): Promise<number> {
  const collection = getCollection();
  const result = await collection.deleteMany({ projectId });
  return result.deletedCount;
}

