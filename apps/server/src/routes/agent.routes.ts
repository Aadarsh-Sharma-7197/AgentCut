import { Router } from "express";
import {
  createAgentRequestHandler,
  getAgentRequestHandler,
  listAgentRequestsHandler,
  cancelAgentRequestHandler,
  approveAgentRequestHandler,
  rejectAgentRequestHandler
} from "../controllers/agent.controller.js";

export const agentRouter = Router({ mergeParams: true });

agentRouter.post("/requests", createAgentRequestHandler);
agentRouter.get("/requests", listAgentRequestsHandler);
agentRouter.get("/requests/:requestId", getAgentRequestHandler);
agentRouter.post("/requests/:requestId/cancel", cancelAgentRequestHandler);
agentRouter.post("/requests/:requestId/approve", approveAgentRequestHandler);
agentRouter.post("/requests/:requestId/reject", rejectAgentRequestHandler);

