import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import {
  type Timeline,
  type CreateRenderJobDTO,
  createRenderPlanFromTimeline
} from "@agentcut/shared";
import * as projectService from "../services/project.service.js";
import * as timelineService from "../services/timeline.service.js";
import * as renderJobService from "../services/render-job.service.js";
import { validateServerRenderPlan } from "../services/render-plan.service.js";
import { RenderValidationError } from "../services/render-job.service.js";

export async function validateRenderPlanHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  try {
    const project = await projectService.getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    let timeline: Timeline | null = null;
    if (req.body?.timeline) {
      timeline = req.body.timeline as Timeline;
    } else {
      timeline = await timelineService.getTimelineByProject(projectId);
    }

    if (!timeline) {
      res.status(404).json({
        error: "Timeline not found for this project. Save a timeline before validating a render plan."
      });
      return;
    }

    const plan = createRenderPlanFromTimeline(timeline, {
      outputConfig: req.body?.outputConfig
    });

    const validation = await validateServerRenderPlan(projectId, plan);

    res.status(200).json({
      data: {
        plan,
        validation: {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings
        }
      }
    });
  } catch (err) {
    console.error("[RenderController] validateRenderPlan error:", err);
    res.status(500).json({ error: "Failed to validate render plan." });
  }
}

export async function createRenderJobHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  try {
    const project = await projectService.getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const payload: CreateRenderJobDTO = req.body || {};
    const job = await renderJobService.createRenderJob(projectId, payload);

    res.status(201).json({ data: job });
  } catch (err) {
    if (err instanceof RenderValidationError) {
      res.status(400).json({
        error: err.message,
        details: err.errors
      });
      return;
    }
    console.error("[RenderController] createRenderJob error:", err);
    res.status(500).json({ error: (err as Error).message || "Failed to create render job." });
  }
}

export async function getRenderJobHandler(req: Request, res: Response): Promise<void> {
  const { projectId, jobId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }
  if (typeof jobId !== "string" || jobId.trim() === "") {
    res.status(400).json({ error: "Invalid render job ID." });
    return;
  }

  try {
    const job = await renderJobService.getRenderJobById(projectId, jobId);
    if (!job) {
      res.status(404).json({ error: "Render job not found." });
      return;
    }

    res.status(200).json({ data: job });
  } catch (err) {
    console.error("[RenderController] getRenderJob error:", err);
    res.status(500).json({ error: "Failed to fetch render job." });
  }
}

export async function listRenderJobsHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  try {
    const jobs = await renderJobService.getRenderJobsByProject(projectId);
    res.status(200).json({ data: jobs });
  } catch (err) {
    console.error("[RenderController] listRenderJobs error:", err);
    res.status(500).json({ error: "Failed to fetch render jobs." });
  }
}

export async function cancelRenderJobHandler(req: Request, res: Response): Promise<void> {
  const { projectId, jobId } = req.params;

  if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }
  if (typeof jobId !== "string" || jobId.trim() === "") {
    res.status(400).json({ error: "Invalid render job ID." });
    return;
  }

  try {
    const job = await renderJobService.cancelRenderJob(projectId, jobId);
    if (!job) {
      res.status(404).json({ error: "Render job not found." });
      return;
    }

    res.status(200).json({ data: job });
  } catch (err) {
    console.error("[RenderController] cancelRenderJob error:", err);
    res.status(400).json({ error: (err as Error).message || "Failed to cancel render job." });
  }
}
