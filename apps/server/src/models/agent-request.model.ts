import { ObjectId, type Collection } from "mongodb";
import type {
  AgentRequest,
  AgentRequestStatus,
  AgentRequestLimits,
  AgentEvent,
  AgentApprovalPlan,
  AgentResult
} from "@agentcut/shared";
import { getDB } from "../config/db.js";

export interface AgentRequestDocument {
  _id: ObjectId;
  requestId: string;
  projectId: string;
  prompt: string;
  status: AgentRequestStatus;
  iterations: number;
  toolCallsCount: number;
  limits: AgentRequestLimits;
  events: AgentEvent[];
  approvalPlan?: AgentApprovalPlan;
  result?: AgentResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export function toAgentRequestDTO(doc: AgentRequestDocument): AgentRequest {
  return {
    id: doc.requestId,
    projectId: doc.projectId,
    prompt: doc.prompt,
    status: doc.status,
    iterations: doc.iterations,
    toolCallsCount: doc.toolCallsCount,
    limits: doc.limits,
    events: doc.events,
    approvalPlan: doc.approvalPlan,
    result: doc.result,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    startedAt: doc.startedAt ? doc.startedAt.toISOString() : undefined,
    completedAt: doc.completedAt ? doc.completedAt.toISOString() : undefined
  };
}

export function getAgentRequestsCollection(): Collection<AgentRequestDocument> {
  return getDB().collection<AgentRequestDocument>("agent_requests");
}

