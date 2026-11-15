import { Router } from "express";
import { getTimelineHandler, putTimelineHandler } from "../controllers/timeline.controller.js";

export const timelineRouter = Router({ mergeParams: true });

timelineRouter.get("/", getTimelineHandler);
timelineRouter.put("/", putTimelineHandler);

