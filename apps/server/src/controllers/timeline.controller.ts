import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { validateTimeline, type Timeline } from "@agentcut/shared";
import * as projectService from "../services/project.service.js";
import * as mediaService from "../services/media.service.js";
import * as timelineService from "../services/timeline.service.js";

export async function getTimelineHandler(req: Request, res: Response): Promise<void> {
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

    const timeline = await timelineService.getTimelineByProject(projectId);
    if (!timeline) {
      res.status(404).json({ error: "Timeline not found for this project." });
      return;
    }

    res.status(200).json({ data: timeline });
  } catch (err) {
    console.error("[TimelineController] getTimeline error:", err);
    res.status(500).json({ error: "Failed to fetch timeline." });
  }
}

export async function putTimelineHandler(req: Request, res: Response): Promise<void> {
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

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Request body must be a valid JSON object." });
      return;
    }

    const { tracks, settings, id } = req.body;

    // Check project ID consistency
    if (req.body.projectId && req.body.projectId !== projectId) {
      res.status(400).json({
        error: "Project ID in request body does not match route parameter."
      });
      return;
    }

    if (!Array.isArray(tracks)) {
      res.status(400).json({ error: "Tracks must be an array." });
      return;
    }

    if (!settings || typeof settings !== "object") {
      res.status(400).json({ error: "Timeline settings must be defined." });
      return;
    }

    // Construct candidate timeline for full validation
    const candidateTimeline: Timeline = {
      id: typeof id === "string" && id.trim() ? id.trim() : "tl_placeholder",
      projectId,
      tracks,
      settings,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Query trusted media assets for this project from MongoDB Atlas
    const projectAssets = await mediaService.getMediaAssetsByProject(projectId);

    // Validate complete timeline, track structure, timing, and media asset compatibility
    const validation = validateTimeline(candidateTimeline, { assets: projectAssets });
    if (!validation.valid) {
      res.status(400).json({
        error: "Timeline validation failed.",
        details: validation.errors
      });
      return;
    }

    // Persist timeline to MongoDB
    const saved = await timelineService.saveTimeline(projectId, {
      id: typeof id === "string" && id.trim() ? id.trim() : undefined,
      tracks,
      settings
    });

    res.status(200).json({ data: saved });
  } catch (err) {
    console.error("[TimelineController] putTimeline error:", err);
    res.status(500).json({ error: "Failed to save timeline." });
  }
}

