import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import * as projectService from "../services/project.service.js";

export async function createProjectHandler(req: Request, res: Response): Promise<void> {
  const { name } = req.body;

  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Project name is required and cannot be empty or whitespace only." });
    return;
  }

  const trimmed = name.trim();
  if (trimmed.length > 100) {
    res.status(400).json({ error: "Project name cannot exceed 100 characters." });
    return;
  }

  try {
    const project = await projectService.createProject(trimmed);
    res.status(201).json({ data: project });
  } catch (err) {
    console.error("[ProjectController] createProject error:", err);
    res.status(500).json({ error: "Failed to create project due to an internal server error." });
  }
}

export async function getAllProjectsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const projects = await projectService.getAllProjects();
    res.status(200).json({ data: projects });
  } catch (err) {
    console.error("[ProjectController] getAllProjects error:", err);
    res.status(500).json({ error: "Failed to fetch projects." });
  }
}

export async function getProjectByIdHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  try {
    const project = await projectService.getProjectById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.status(200).json({ data: project });
  } catch (err) {
    console.error("[ProjectController] getProjectById error:", err);
    res.status(500).json({ error: "Failed to fetch project." });
  }
}

export async function deleteProjectHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    res.status(400).json({ error: "Invalid project ID format." });
    return;
  }

  try {
    const deleted = await projectService.deleteProject(id);
    if (!deleted) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.status(200).json({ message: "Project deleted successfully." });
  } catch (err) {
    console.error("[ProjectController] deleteProject error:", err);
    res.status(500).json({ error: "Failed to delete project." });
  }
}
