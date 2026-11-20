export class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentValidationError";
  }
}

export class AgentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNotFoundError";
  }
}

export class AgentStateTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition agent request from '${from}' to '${to}'.`);
    this.name = "AgentStateTransitionError";
  }
}

export class AgentCancellationError extends Error {
  constructor(message = "Agent execution was canceled.") {
    super(message);
    this.name = "AgentCancellationError";
  }
}

export class AgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent execution timed out after ${timeoutMs}ms.`);
    this.name = "AgentTimeoutError";
  }
}

export class AgentLimitExceededError extends Error {
  constructor(limitType: "iterations" | "tool_calls", limitValue: number) {
    super(`Agent execution exceeded maximum ${limitType} limit of ${limitValue}.`);
    this.name = "AgentLimitExceededError";
  }
}

export class AgentSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSecurityError";
  }
}

export class PlanHashMismatchError extends Error {
  public readonly code = "PLAN_HASH_MISMATCH";
  public readonly statusCode = 400;

  constructor(message = "Plan hash mismatch. The provided plan hash does not match the canonical stored plan.") {
    super(message);
    this.name = "PlanHashMismatchError";
  }
}

export class StaleTimelineRevisionError extends Error {
  public readonly code = "STALE_TIMELINE_REVISION";
  public readonly statusCode = 409;
  public readonly details: { expectedRevision: number; actualRevision: number };

  constructor(details: { expectedRevision: number; actualRevision: number }) {
    super(
      `Timeline revision conflict. Expected revision ${details.expectedRevision}, but current timeline revision is ${details.actualRevision}.`
    );
    this.name = "StaleTimelineRevisionError";
    this.details = details;
  }
}

export class RequestNotApprovableError extends Error {
  public readonly code = "REQUEST_NOT_APPROVABLE";
  public readonly statusCode = 409;

  constructor(currentStatus: string, reason?: string) {
    super(
      reason || `Agent request cannot be approved in state '${currentStatus}'. Expected 'awaiting_approval'.`
    );
    this.name = "RequestNotApprovableError";
  }
}

export class ExecutionAlreadyStartedError extends Error {
  public readonly code = "EXECUTION_ALREADY_STARTED";
  public readonly statusCode = 409;
  public readonly executionId?: string;

  constructor(executionId?: string) {
    super(`Execution for this plan is already in progress${executionId ? ` (executionId: ${executionId})` : ""}.`);
    this.name = "ExecutionAlreadyStartedError";
    this.executionId = executionId;
  }
}

export class ExecutionValidationFailedError extends Error {
  public readonly code = "EXECUTION_VALIDATION_FAILED";
  public readonly statusCode = 422;

  constructor(message: string) {
    super(`Plan execution validation failed: ${message}`);
    this.name = "ExecutionValidationFailedError";
  }
}

export class ExecutionAbortedCrashError extends Error {
  public readonly code = "EXECUTION_ABORTED_CRASH";
  public readonly statusCode = 500;

  constructor(message = "Execution was aborted due to an uncommitted server crash or restart.") {
    super(message);
    this.name = "ExecutionAbortedCrashError";
  }
}

