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

export class TimelineConcurrencyError extends Error {
  public readonly code = "STALE_TIMELINE_REVISION";
  public readonly details: { expectedRevision: number; actualRevision: number };

  constructor(details: { expectedRevision: number; actualRevision: number }) {
    super(
      `Timeline concurrency conflict: expected revision ${details.expectedRevision}, but found revision ${details.actualRevision}.`
    );
    this.name = "TimelineConcurrencyError";
    this.details = details;
  }
}

export class TimelineNotFoundError extends Error {
  public readonly code = "TIMELINE_NOT_FOUND";

  constructor(projectId: string) {
    super(`Timeline not found for project '${projectId}'.`);
    this.name = "TimelineNotFoundError";
  }
}

export interface SaveTimelineInput {
  id?: string;
  tracks: Track[];
  settings: TimelineSettings;
}

export interface SaveTimelineOptions {
  expectedRevision?: number;
  lastExecutionId?: string;
}

export interface SaveTimelineCASOptions {
  expectedRevision: number;
  lastExecutionId?: string;
}

/**
 * Persists a timeline mutation using Compare-And-Swap (CAS) revision protection.
 * Atomically checks expectedRevision and increments revision by 1.
 * Supports legacy timelines without a revision field (normalizes missing as 1).
 */
export async function saveTimelineCAS(
  projectId: string,
  input: SaveTimelineInput,
  options: SaveTimelineCASOptions
): Promise<Timeline> {
  const collection = getCollection();
  const now = new Date();

  // Match document where projectId matches AND revision matches expectedRevision.
  // Legacy compatibility: If expectedRevision is 1, also match if revision field is missing entirely.
  const query: Record<string, unknown> = {
    projectId,
    $or: [
      { revision: options.expectedRevision },
      ...(options.expectedRevision === 1 ? [{ revision: { $exists: false } }] : [])
    ]
  };

  const update: Record<string, unknown> = {
    $set: {
      tracks: input.tracks,
      settings: input.settings,
      revision: options.expectedRevision + 1,
      updatedAt: now,
      ...(options.lastExecutionId ? { lastExecutionId: options.lastExecutionId } : {})
    }
  };

  const result = await collection.findOneAndUpdate(query, update, {
    returnDocument: "after"
  });

  if (!result) {
    // Check if timeline does not exist at all or if revision conflicted
    const currentDoc = await collection.findOne({ projectId });
    if (!currentDoc) {
      throw new TimelineNotFoundError(projectId);
    }
    const actualRevision =
      typeof currentDoc.revision === "number" &&
      Number.isInteger(currentDoc.revision) &&
      currentDoc.revision >= 1
        ? currentDoc.revision
        : 1;

    throw new TimelineConcurrencyError({
      expectedRevision: options.expectedRevision,
      actualRevision
    });
  }

  return toTimelineDTO(result);
}

export async function saveTimeline(
  projectId: string,
  input: SaveTimelineInput,
  options?: SaveTimelineOptions
): Promise<Timeline> {
  // If expectedRevision was explicitly provided, delegate to CAS
  if (options?.expectedRevision !== undefined) {
    return saveTimelineCAS(projectId, input, {
      expectedRevision: options.expectedRevision,
      lastExecutionId: options.lastExecutionId
    });
  }

  const collection = getCollection();
  const now = new Date();
  const generatedId = input.id || new ObjectId().toHexString();

  // Legacy compatibility: If the existing document lacks a revision field,
  // its logical revision is 1, so the first mutation must transition it to revision 2.
  const legacyResult = await collection.findOneAndUpdate(
    { projectId, revision: { $exists: false } },
    {
      $set: {
        tracks: input.tracks,
        settings: input.settings,
        revision: 2,
        updatedAt: now,
        ...(options?.lastExecutionId ? { lastExecutionId: options.lastExecutionId } : {})
      }
    },
    { returnDocument: "after" }
  );

  if (legacyResult) {
    return toTimelineDTO(legacyResult);
  }

  // Atomic upsert with monotonic revision increment:
  // For new insertions, $inc treats non-existent revision as 0 -> sets revision = 1.
  // For updates on documents with an existing revision, $inc increments existing revision by 1.
  // Under concurrent updates, $setOnInsert guarantees timelineId, projectId,
  // and createdAt are only set on initial document insertion and are strictly preserved thereafter.
  const result = await collection.findOneAndUpdate(
    { projectId },
    {
      $set: {
        tracks: input.tracks,
        settings: input.settings,
        updatedAt: now,
        ...(options?.lastExecutionId ? { lastExecutionId: options.lastExecutionId } : {})
      },
      $inc: {
        revision: 1
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

