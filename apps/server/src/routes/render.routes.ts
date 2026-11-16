import { Router } from "express";
import {
  validateRenderPlanHandler,
  createRenderJobHandler,
  getRenderJobHandler,
  listRenderJobsHandler,
  cancelRenderJobHandler
} from "../controllers/render.controller.js";

export const renderRouter = Router({ mergeParams: true });

// POST /api/projects/:projectId/render/plan — Validates timeline and returns structured RenderPlan
renderRouter.post("/plan", validateRenderPlanHandler);

// POST /api/projects/:projectId/render/jobs — Prepares and enqueues a render job
renderRouter.post("/jobs", createRenderJobHandler);

// GET /api/projects/:projectId/render/jobs/:jobId — Retrieves job status and progress
renderRouter.get("/jobs/:jobId", getRenderJobHandler);

// GET /api/projects/:projectId/render/jobs — Lists render jobs for the project
renderRouter.get("/jobs", listRenderJobsHandler);

// POST /api/projects/:projectId/render/jobs/:jobId/cancel — Cancels a render job
renderRouter.post("/jobs/:jobId/cancel", cancelRenderJobHandler);

