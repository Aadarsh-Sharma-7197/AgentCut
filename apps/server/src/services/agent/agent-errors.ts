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

