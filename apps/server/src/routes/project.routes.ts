import { Router } from "express";
import {
  createProjectHandler,
  getAllProjectsHandler,
  getProjectByIdHandler,
  deleteProjectHandler
} from "../controllers/project.controller.js";
import { searchProjectIntelligenceHandler } from "../controllers/media.controller.js";
import { mediaRouter } from "./media.routes.js";
import { timelineRouter } from "./timeline.routes.js";
import { renderRouter } from "./render.routes.js";

export const projectRouter = Router();

projectRouter.post("/", createProjectHandler);
projectRouter.get("/", getAllProjectsHandler);
projectRouter.get("/:id", getProjectByIdHandler);
projectRouter.delete("/:id", deleteProjectHandler);

// Mount media assets routes under /api/projects/:projectId/media
projectRouter.use("/:projectId/media", mediaRouter);

// Project-wide media intelligence search (Step 5.6)
projectRouter.get("/:projectId/intelligence/search", searchProjectIntelligenceHandler);


// Mount timeline persistence routes under /api/projects/:projectId/timeline
projectRouter.use("/:projectId/timeline", timelineRouter);

// Mount rendering routes under /api/projects/:projectId/render
projectRouter.use("/:projectId/render", renderRouter);

