import { Router } from "express";
import {
  createProjectHandler,
  getAllProjectsHandler,
  getProjectByIdHandler,
  deleteProjectHandler
} from "../controllers/project.controller.js";
import { mediaRouter } from "./media.routes.js";

export const projectRouter = Router();

projectRouter.post("/", createProjectHandler);
projectRouter.get("/", getAllProjectsHandler);
projectRouter.get("/:id", getProjectByIdHandler);
projectRouter.delete("/:id", deleteProjectHandler);

// Mount media assets routes under /api/projects/:projectId/media
projectRouter.use("/:projectId/media", mediaRouter);

