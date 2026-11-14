import { Router } from "express";
import {
  createProjectHandler,
  getAllProjectsHandler,
  getProjectByIdHandler,
  deleteProjectHandler
} from "../controllers/project.controller.js";

export const projectRouter = Router();

projectRouter.post("/", createProjectHandler);
projectRouter.get("/", getAllProjectsHandler);
projectRouter.get("/:id", getProjectByIdHandler);
projectRouter.delete("/:id", deleteProjectHandler);

