import { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import {
  type RenderJob,
  type RenderJobStatus,
  type CreateRenderJobDTO,
  createRenderPlanFromTimeline
} from "@agentcut/shared";
import { RenderJobDocument, toRenderJobDTO } from "../models/render-job.model.js";
import * as timelineService from "./timeline.service.js";
import { validateServerRenderPlan } from "./render-plan.service.js";
import { executeRenderJob, cancelActiveRender, isJobActive } from "./render-pipeline.service.js";

const COLLECTION_NAME = "render_jobs";

function getCollection(): Collection<RenderJobDocument> {
  return getDB().collection<RenderJobDocument>(COLLECTION_NAME);
}

export async function initRenderJobIndexes(): Promise<void> {
  try {
    const col = getCollection();
    await col.createIndex({ projectId: 1, createdAt: -1 });
    await col.createIndex({ jobId: 1 }, { unique: true });
  } catch (err) {
    console.error("[RenderJobService] Error creating indexes:", err);
  }
}

export class RenderValidationError extends Error {
  public errors: string[];
  constructor(message: string, errors: string[]) {
    super(message);
    this.name = "RenderValidationError";
    this.errors = errors;
  }
}

/**
 * Creates and persists a new RenderJob in the "queued" status.
 * Strictly validates the project's timeline and assets before accepting the job.
 * Does NOT execute FFmpeg (FFmpeg execution belongs to Step 4.2).
 */
export async function createRenderJob(
  projectId: string,
  input?: CreateRenderJobDTO
): Promise<RenderJob> {
  // 1. Retrieve the saved timeline for the project
  const timeline = await timelineService.getTimelineByProject(projectId);
  if (!timeline) {
    throw new Error("No timeline found for this project. Save a timeline before requesting a render.");
  }

  // 2. Generate structured render plan
  const plan = createRenderPlanFromTimeline(timeline, {
    outputConfig: input?.outputConfig
  });

  // 3. Perform server-side validation against project database records and disk files
  const validation = await validateServerRenderPlan(projectId, plan);
  if (!validation.valid) {
    throw new RenderValidationError(
      `Render plan validation failed with ${validation.errors.length} error(s).`,
      validation.errors
    );
  }

  // 4. Persist the render job document in MongoDB
  const collection = getCollection();
  const now = new Date();
  const jobId = new ObjectId().toHexString();

  const doc: RenderJobDocument = {
    _id: new ObjectId(),
    jobId,
    projectId,
    timelineId: timeline.id,
    status: "queued",
    progress: 0,
    plan,
    createdAt: now,
    updatedAt: now
  };

  await collection.insertOne(doc);
  const dto = toRenderJobDTO(doc);

  // Trigger background render pipeline asynchronously without blocking HTTP response
  setImmediate(() => {
    executeRenderJob(jobId).catch((err) => {
      console.error(`[RenderJobService] Error starting render pipeline for job ${jobId}:`, err);
    });
  });

  return dto;
}

/**
 * Retrieves the raw MongoDB document of a render job by its job ID.
 */
export async function getRenderJobRawById(jobId: string): Promise<RenderJobDocument | null> {
  const collection = getCollection();
  return collection.findOne({ jobId });
}

/**
 * Retrieves a render job by its project ID and job ID.
 */
export async function getRenderJobById(
  projectId: string,
  jobId: string
): Promise<RenderJob | null> {
  const collection = getCollection();
  const doc = await collection.findOne({ projectId, jobId });
  if (!doc) {
    return null;
  }
  return toRenderJobDTO(doc);
}

/**
 * Retrieves all render jobs for a project sorted by creation date descending.
 */
export async function getRenderJobsByProject(projectId: string): Promise<RenderJob[]> {
  const collection = getCollection();
  const docs = await collection
    .find({ projectId })
    .sort({ createdAt: -1 })
    .toArray();

  return docs.map(toRenderJobDTO);
}

/**
 * Updates the status and metadata of a render job.
 */
export async function updateRenderJobStatus(
  jobId: string,
  status: RenderJobStatus,
  updates?: {
    progress?: number;
    error?: string;
    outputMetadata?: RenderJobDocument["outputMetadata"];
  }
): Promise<RenderJob | null> {
  const collection = getCollection();
  const now = new Date();

  const updateFields: Partial<RenderJobDocument> = {
    status,
    updatedAt: now
  };

  if (typeof updates?.progress === "number") {
    updateFields.progress = updates.progress;
  }
  if (updates?.error !== undefined) {
    updateFields.error = updates.error;
  }
  if (updates?.outputMetadata !== undefined) {
    updateFields.outputMetadata = updates.outputMetadata;
  }

  const filter: Record<string, unknown> = { jobId };
  if (status !== "canceled") {
    // A canceled job must never be overwritten by in-flight queued/validating/rendering updates
    filter.status = { $ne: "canceled" };
  }

  const result = await collection.findOneAndUpdate(
    filter,
    { $set: updateFields },
    { returnDocument: "after" }
  );

  if (!result) {
    return getRenderJobRawById(jobId).then((doc) => (doc ? toRenderJobDTO(doc) : null));
  }

  return toRenderJobDTO(result);
}

/**
 * Cancels a queued or validating render job.
 */
export async function cancelRenderJob(
  projectId: string,
  jobId: string
): Promise<RenderJob | null> {
  const job = await getRenderJobById(projectId, jobId);
  if (!job) {
    return null;
  }

  if (job.status === "completed" || job.status === "failed") {
    throw new Error(`Cannot cancel a job with status '${job.status}'.`);
  }

  // If process is actively running in background, cancel process and clean up temporary files
  if (isJobActive(jobId)) {
    await cancelActiveRender(jobId);
    return getRenderJobById(projectId, jobId);
  }

  return updateRenderJobStatus(jobId, "canceled");
}

/**
 * Removes render job metadata documents for a project from MongoDB.
 * Never touches or removes any physical files on disk.
 */
export async function deleteRenderJobsByProject(projectId: string): Promise<number> {
  const collection = getCollection();
  const result = await collection.deleteMany({ projectId });
  return result.deletedCount;
}


