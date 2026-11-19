import type {
  AgentRequestStatus,
  AgentEvent,
  AgentApprovalPlan,
  AgentEditingPlan,
  AgentResult
} from "@agentcut/shared";
import type { AgentExecutionContext, AgentPlanProvider } from "./agent-context.js";
import type { AgentToolRegistry } from "./agent-tools.js";
import {
  AgentCancellationError,
  AgentTimeoutError,
  AgentLimitExceededError,
  AgentSecurityError
} from "./agent-errors.js";

export interface AgentExecutionResult {
  status: AgentRequestStatus;
  events: AgentEvent[];
  iterations: number;
  toolCallsCount: number;
  result?: AgentResult;
  approvalPlan?: AgentApprovalPlan;
  editingPlan?: AgentEditingPlan;
  error?: string;
}

export class AgentRuntimeOrchestrator {
  constructor(
    private readonly toolRegistry: AgentToolRegistry
  ) {}

  public async execute(
    context: AgentExecutionContext,
    provider: AgentPlanProvider
  ): Promise<AgentExecutionResult> {
    let timeoutTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    try {
      context.checkCancellation();

      // Set up execution timeout
      if (context.limits.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          // Trigger abort on signal if possible, or context check will catch it
        }, context.limits.timeoutMs);
      }

      // Record start if not already done
      const hasStarted = context.events.some((e) => e.type === "request_started");
      if (!hasStarted) {
        context.recordEvent("request_started", "Agent execution started.");
      }

      while (true) {
        context.checkCancellation();

        if (timedOut || Date.now() - context.startedAt >= context.limits.timeoutMs) {
          throw new AgentTimeoutError(context.limits.timeoutMs);
        }

        if (context.currentIteration >= context.limits.maxIterations) {
          throw new AgentLimitExceededError("iterations", context.limits.maxIterations);
        }

        context.currentIteration++;
        context.recordEvent(
          "iteration_started",
          `Started agent iteration ${context.currentIteration}/${context.limits.maxIterations}.`,
          { iteration: context.currentIteration }
        );

        context.checkCancellation();

        const decision = await provider.generateStep(context);

        if (timedOut || Date.now() - context.startedAt >= context.limits.timeoutMs) {
          throw new AgentTimeoutError(context.limits.timeoutMs);
        }

        context.checkCancellation();

        if (decision.type === "finish") {
          context.recordEvent(
            "request_completed",
            "Agent completed execution successfully.",
            decision.result ? { summary: decision.result.summary } : undefined
          );
          return {
            status: "completed",
            events: context.events,
            iterations: context.currentIteration,
            toolCallsCount: context.toolCallCount,
            result: decision.result
          };
        }

        if (decision.type === "ask_approval") {
          const rawEditingPlan = decision.plan.editingPlan;
          const editingPlan = rawEditingPlan
            ? { ...rawEditingPlan, status: "proposed" as const }
            : undefined;
          context.recordEvent(
            "approval_requested",
            "Agent requested user approval before continuing.",
            { description: decision.plan.description, editingPlanId: editingPlan?.id }
          );
          return {
            status: "awaiting_approval",
            events: context.events,
            iterations: context.currentIteration,
            toolCallsCount: context.toolCallCount,
            approvalPlan: decision.plan,
            editingPlan
          };
        }

        if (decision.type === "fail") {
          context.recordEvent(
            "request_failed",
            `Agent execution failed: ${decision.error}`,
            { error: decision.error }
          );
          return {
            status: "failed",
            events: context.events,
            iterations: context.currentIteration,
            toolCallsCount: context.toolCallCount,
            error: decision.error
          };
        }

        if (decision.type === "tool_call") {
          if (context.toolCallCount >= context.limits.maxToolCalls) {
            throw new AgentLimitExceededError("tool_calls", context.limits.maxToolCalls);
          }

          const tool = this.toolRegistry.getTool(decision.toolName);
          if (!tool) {
            throw new AgentSecurityError(
              `Tool '${decision.toolName}' is not allowlisted or registered.`
            );
          }

          let validatedInput: unknown;
          try {
            validatedInput = tool.validate(decision.params);
          } catch (valErr) {
            const valErrMsg = valErr instanceof Error ? valErr.message : String(valErr);
            throw new AgentSecurityError(
              `Validation failed for tool '${decision.toolName}': ${valErrMsg}`
            );
          }

          context.recordEvent(
            "tool_call_started",
            `Invoking tool '${decision.toolName}'.`,
            { tool: decision.toolName }
          );

          context.checkCancellation();

          try {
            const output = await tool.execute(validatedInput, context);
            context.toolCallCount++;
            context.recordEvent(
              "tool_call_completed",
              `Tool '${decision.toolName}' completed successfully.`,
              { tool: decision.toolName, output: typeof output === "object" ? output : { result: output } }
            );
          } catch (execErr) {
            context.toolCallCount++;
            const execErrMsg = execErr instanceof Error ? execErr.message : String(execErr);
            context.recordEvent(
              "tool_call_failed",
              `Tool '${decision.toolName}' failed: ${execErrMsg}`,
              { tool: decision.toolName, error: execErrMsg }
            );
          }

          if (timedOut || Date.now() - context.startedAt >= context.limits.timeoutMs) {
            throw new AgentTimeoutError(context.limits.timeoutMs);
          }
        }
      }
    } catch (err) {
      if (
        err instanceof AgentTimeoutError ||
        timedOut ||
        Date.now() - context.startedAt >= context.limits.timeoutMs
      ) {
        const timeoutMessage = `Agent execution timed out after ${context.limits.timeoutMs}ms.`;
        context.recordEvent("request_failed", timeoutMessage, { timeoutMs: context.limits.timeoutMs });
        return {
          status: "failed",
          events: context.events,
          iterations: context.currentIteration,
          toolCallsCount: context.toolCallCount,
          error: timeoutMessage
        };
      }

      if (err instanceof AgentCancellationError || context.signal.aborted) {
        context.recordEvent("request_canceled", "Agent execution was canceled.");
        return {
          status: "canceled",
          events: context.events,
          iterations: context.currentIteration,
          toolCallsCount: context.toolCallCount
        };
      }

      if (err instanceof AgentLimitExceededError) {
        context.recordEvent("request_failed", err.message);
        return {
          status: "failed",
          events: context.events,
          iterations: context.currentIteration,
          toolCallsCount: context.toolCallCount,
          error: err.message
        };
      }

      if (err instanceof AgentSecurityError) {
        context.recordEvent("request_failed", err.message);
        return {
          status: "failed",
          events: context.events,
          iterations: context.currentIteration,
          toolCallsCount: context.toolCallCount,
          error: err.message
        };
      }

      console.error("[AgentRuntimeOrchestrator] Unexpected execution error:", err);
      const safeMessage = "An unexpected error occurred during agent execution.";
      context.recordEvent("request_failed", safeMessage);
      return {
        status: "failed",
        events: context.events,
        iterations: context.currentIteration,
        toolCallsCount: context.toolCallCount,
        error: safeMessage
      };
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  }
}
