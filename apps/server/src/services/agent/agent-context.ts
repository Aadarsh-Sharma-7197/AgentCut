import crypto from "crypto";
import type {
  AgentEvent,
  AgentEventType,
  AgentRequestLimits,
  AgentApprovalPlan,
  AgentResult
} from "@agentcut/shared";
import { AgentCancellationError } from "./agent-errors.js";

export type AgentStepDecision =
  | { type: "tool_call"; toolName: string; params: Record<string, unknown> }
  | { type: "ask_approval"; plan: AgentApprovalPlan }
  | { type: "finish"; result: AgentResult }
  | { type: "fail"; error: string };

export interface AgentPlanProvider {
  generateStep(context: AgentExecutionContext): Promise<AgentStepDecision>;
}

export interface AgentExecutionContext {
  readonly requestId: string;
  readonly projectId: string;
  readonly prompt: string;
  currentIteration: number;
  toolCallCount: number;
  readonly limits: AgentRequestLimits;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly events: AgentEvent[];

  checkCancellation(): void;
  recordEvent(
    type: AgentEventType,
    message: string,
    data?: Record<string, unknown>
  ): AgentEvent;
}

export class DefaultAgentExecutionContext implements AgentExecutionContext {
  public readonly requestId: string;
  public readonly projectId: string;
  public readonly prompt: string;
  public currentIteration: number = 0;
  public toolCallCount: number = 0;
  public readonly limits: AgentRequestLimits;
  public readonly signal: AbortSignal;
  public readonly startedAt: number;
  public readonly events: AgentEvent[];
  private readonly onEventCallback?: (event: AgentEvent) => void;

  constructor(options: {
    requestId: string;
    projectId: string;
    prompt: string;
    limits: AgentRequestLimits;
    signal: AbortSignal;
    existingEvents?: AgentEvent[];
    currentIteration?: number;
    toolCallCount?: number;
    startedAt?: number;
    onEvent?: (event: AgentEvent) => void;
  }) {
    this.requestId = options.requestId;
    this.projectId = options.projectId;
    this.prompt = options.prompt;
    this.limits = options.limits;
    this.signal = options.signal;
    this.events = options.existingEvents ? [...options.existingEvents] : [];
    this.currentIteration = options.currentIteration ?? 0;
    this.toolCallCount = options.toolCallCount ?? 0;
    this.startedAt = options.startedAt ?? Date.now();
    this.onEventCallback = options.onEvent;
  }

  public checkCancellation(): void {
    if (this.signal.aborted) {
      throw new AgentCancellationError();
    }
  }

  public recordEvent(
    type: AgentEventType,
    message: string,
    data?: Record<string, unknown>
  ): AgentEvent {
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      message,
      data
    };
    this.events.push(event);
    if (this.onEventCallback) {
      try {
        this.onEventCallback(event);
      } catch (err) {
        console.error("[AgentExecutionContext] Error in event callback:", err);
      }
    }
    return event;
  }
}

