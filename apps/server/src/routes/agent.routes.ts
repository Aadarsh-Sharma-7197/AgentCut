import { Router } from "express";
import {
  createAgentRequestHandler,
  getAgentRequestHandler,
  listAgentRequestsHandler,
  cancelAgentRequestHandler
} from "../controllers/agent.controller.js";

export const agentRouter = Router({ mergeParams: true });

agentRouter.post("/requests", createAgentRequestHandler);
agentRouter.get("/requests", listAgentRequestsHandler);
agentRouter.get("/requests/:requestId", getAgentRequestHandler);
agentRouter.post("/requests/:requestId/cancel", cancelAgentRequestHandler);

