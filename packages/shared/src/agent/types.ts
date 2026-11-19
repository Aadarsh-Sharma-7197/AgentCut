export type AgentRequestStatus =
  | "queued"
  | "processing"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "canceled";

export type AgentEventType =
  | "request_queued"
  | "request_started"
  | "iteration_started"
  | "tool_call_started"
  | "tool_call_completed"
  | "tool_call_failed"
  | "approval_requested"
  | "approval_granted"
  | "approval_rejected"
  | "request_completed"
  | "request_failed"
  | "request_canceled";

export interface AgentEvent {
  id: string;
  timestamp: string;
  type: AgentEventType;
  message: string;
  data?: Record<string, unknown>;
}

export interface AgentRequestLimits {
  maxIterations: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface AgentApprovalAction {
  toolName: string;
  params: Record<string, unknown>;
  description?: string;
}

export type ProposedOperationType =
  | "remove_silence"
  | "split_clip"
  | "trim_clip"
  | "move_clip"
  | "delete_clip";

export const SUPPORTED_PROPOSED_OPERATIONS = [
  "remove_silence",
  "split_clip",
  "trim_clip",
  "move_clip",
  "delete_clip"
] as const;

export type PlanStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "applied";

export interface PlanEvidenceReference {
  type: "speech" | "silence" | "scene";
  assetId: string;
  start?: number;
  end?: number;
  snippet?: string;
  frameUrl?: string;
}

export interface ProposedOperation {
  id: string;
  type: ProposedOperationType;
  description: string;
  explanation?: string;
  assetId?: string;
  trackId?: string;
  clipId?: string;
  timeRange?: {
    sourceStart?: number;
    sourceEnd?: number;
    timelineStart?: number;
    timelineEnd?: number;
  };
  params: Record<string, unknown>;
  evidence?: PlanEvidenceReference[];
}

export interface AgentEditingPlan {
  id: string;
  requestId: string;
  projectId: string;
  timelineId?: string;
  summary: string;
  operations: ProposedOperation[];
  warnings?: string[];
  assumptions?: string[];
  status: PlanStatus;
  createdAt: string;
}

export interface AgentApprovalPlan {
  description: string;
  proposedActions: AgentApprovalAction[];
  estimatedImpact?: string;
  editingPlan?: AgentEditingPlan;
}

export interface AgentResult {
  summary?: string;
  output?: Record<string, unknown>;
}

export type AgentStepDecision =
  | { type: "tool_call"; toolName: string; params: Record<string, unknown> }
  | { type: "ask_approval"; plan: AgentApprovalPlan; editingPlan?: AgentEditingPlan }
  | { type: "finish"; result: AgentResult }
  | { type: "fail"; error: string };


export interface AgentRequest {
  id: string;
  projectId: string;
  prompt: string;
  status: AgentRequestStatus;
  iterations: number;
  toolCallsCount: number;
  limits: AgentRequestLimits;
  events: AgentEvent[];
  approvalPlan?: AgentApprovalPlan;
  editingPlan?: AgentEditingPlan;
  result?: AgentResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateAgentRequestDTO {
  prompt: string;
  maxIterations?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

export const VALID_STATUS_TRANSITIONS: Record<AgentRequestStatus, readonly AgentRequestStatus[]> = {
  queued: ["processing", "canceled"],
  processing: ["awaiting_approval", "completed", "failed", "canceled"],
  awaiting_approval: ["processing", "completed", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: []
};

export function isValidAgentStatusTransition(
  from: AgentRequestStatus,
  to: AgentRequestStatus
): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export const AGENT_SAFETY_LIMITS = {
  DEFAULT_MAX_ITERATIONS: 10,
  MIN_MAX_ITERATIONS: 1,
  MAX_MAX_ITERATIONS: 50,
  DEFAULT_MAX_TOOL_CALLS: 25,
  MIN_MAX_TOOL_CALLS: 1,
  MAX_MAX_TOOL_CALLS: 100,
  DEFAULT_TIMEOUT_MS: 60000,
  MIN_TIMEOUT_MS: 1000,
  MAX_TIMEOUT_MS: 300000,
  MAX_PROMPT_LENGTH: 4000
} as const;

