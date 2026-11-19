import type {
  AgentStepDecision,
  AgentApprovalPlan,
  AgentEditingPlan,
  ProposedOperationType,
  AgentResult
} from "@agentcut/shared";
import { SUPPORTED_PROPOSED_OPERATIONS } from "@agentcut/shared";
import type { AgentToolRegistry } from "../agent-tools.js";
import { AgentValidationError, AgentSecurityError } from "../agent-errors.js";
import { validateEditingPlan } from "../plan-validator.js";
import crypto from "crypto";

export const MAX_GEMINI_RESPONSE_BYTES = 65536; // 64 KB safety limit

export const GEMINI_AGENT_DECISION_SCHEMA = {
  type: "OBJECT",
  description: "Structured agent decision for AgentCut video editing orchestrator",
  properties: {
    decisionType: {
      type: "STRING",
      description: "The type of decision made by the agent.",
      enum: ["tool_call", "ask_approval", "finish", "fail"]
    },
    explanation: {
      type: "STRING",
      description: "Concise reasoning behind this step decision."
    },
    toolCall: {
      type: "OBJECT",
      description: "Required when decisionType is 'tool_call'.",
      properties: {
        toolName: {
          type: "STRING",
          description: "Name of the allowlisted tool to invoke."
        },
        params: {
          type: "OBJECT",
          description: "Key-value parameters for the tool."
        }
      }
    },
    approvalPlan: {
      type: "OBJECT",
      description: "Required when decisionType is 'ask_approval'.",
      properties: {
        description: {
          type: "STRING",
          description: "Summary of the proposed plan requiring user approval."
        },
        proposedActions: {
          type: "ARRAY",
          description: "List of proposed actions.",
          items: {
            type: "OBJECT",
            properties: {
              toolName: { type: "STRING" },
              params: { type: "OBJECT" },
              description: { type: "STRING" }
            },
            required: ["toolName"]
          }
        },
        estimatedImpact: {
          type: "STRING",
          description: "Optional explanation of impact on the timeline."
        },
        editingPlan: {
          type: "OBJECT",
          description: "Structured editing plan containing proposed editing operations and evidence.",
          properties: {
            id: { type: "STRING" },
            summary: { type: "STRING" },
            operations: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  id: { type: "STRING" },
                  type: {
                    type: "STRING",
                    enum: ["remove_silence", "split_clip", "trim_clip", "move_clip", "delete_clip"]
                  },
                  description: { type: "STRING" },
                  explanation: { type: "STRING" },
                  assetId: { type: "STRING" },
                  trackId: { type: "STRING" },
                  clipId: { type: "STRING" },
                  timeRange: {
                    type: "OBJECT",
                    properties: {
                      sourceStart: { type: "NUMBER" },
                      sourceEnd: { type: "NUMBER" },
                      timelineStart: { type: "NUMBER" },
                      timelineEnd: { type: "NUMBER" }
                    }
                  },
                  params: { type: "OBJECT" },
                  evidence: {
                    type: "ARRAY",
                    items: {
                      type: "OBJECT",
                      properties: {
                        type: { type: "STRING", enum: ["speech", "silence", "scene"] },
                        assetId: { type: "STRING" },
                        start: { type: "NUMBER" },
                        end: { type: "NUMBER" },
                        snippet: { type: "STRING" },
                        frameUrl: { type: "STRING" }
                      },
                      required: ["type", "assetId"]
                    }
                  }
                },
                required: ["type", "description"]
              }
            },
            warnings: { type: "ARRAY", items: { type: "STRING" } },
            assumptions: { type: "ARRAY", items: { type: "STRING" } }
          }
        }
      }
    },
    result: {
      type: "OBJECT",
      description: "Required when decisionType is 'finish'.",
      properties: {
        summary: {
          type: "STRING",
          description: "Summary of the completed task."
        }
      }
    },
    failureReason: {
      type: "STRING",
      description: "Required when decisionType is 'fail'."
    }
  },
  required: ["decisionType"]
};

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "decisionType",
  "explanation",
  "toolCall",
  "approvalPlan",
  "result",
  "failureReason"
]);

/**
 * Validates and normalizes raw JSON output from Gemini into an AgentStepDecision.
 */
export function validateGeminiDecision(
  raw: unknown,
  toolRegistry?: AgentToolRegistry
): AgentStepDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentValidationError("Model response must be a non-empty JSON object.");
  }

  const record = raw as Record<string, unknown>;

  // Check for unexpected extra fields to prevent payload confusion
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new AgentValidationError(`Unexpected field '${key}' in model decision.`);
    }
  }

  const decisionType = record.decisionType;
  if (typeof decisionType !== "string") {
    throw new AgentValidationError("Missing 'decisionType' in model response.");
  }

  if (
    decisionType !== "tool_call" &&
    decisionType !== "ask_approval" &&
    decisionType !== "finish" &&
    decisionType !== "fail"
  ) {
    throw new AgentValidationError(
      `Unknown decisionType '${decisionType}'. Expected 'tool_call', 'ask_approval', 'finish', or 'fail'.`
    );
  }

  switch (decisionType) {
    case "tool_call": {
      const tc = record.toolCall;
      if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
        throw new AgentValidationError("'toolCall' object is required when decisionType is 'tool_call'.");
      }
      const toolCallObj = tc as Record<string, unknown>;
      const toolName = toolCallObj.toolName;
      if (typeof toolName !== "string" || !toolName.trim()) {
        throw new AgentValidationError("toolCall.toolName must be a non-empty string.");
      }
      const trimmedToolName = toolName.trim();

      if (toolRegistry) {
        if (!toolRegistry.hasTool(trimmedToolName)) {
          throw new AgentSecurityError(
            `Tool '${trimmedToolName}' is not allowlisted or registered.`
          );
        }
      }

      let params = toolCallObj.params ?? {};
      if (typeof params === "string") {
        try {
          params = JSON.parse(params);
        } catch {
          throw new AgentValidationError(
            `Invalid JSON string for toolCall.params in '${trimmedToolName}'.`
          );
        }
      }
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new AgentValidationError(`toolCall.params must be an object for '${trimmedToolName}'.`);
      }

      if (toolRegistry) {
        const tool = toolRegistry.getTool(trimmedToolName);
        if (tool) {
          try {
            params = tool.validate(params);
          } catch (valErr) {
            const msg = valErr instanceof Error ? valErr.message : String(valErr);
            throw new AgentValidationError(
              `Tool arguments validation failed for '${trimmedToolName}': ${msg}`
            );
          }
        }
      }

      return {
        type: "tool_call",
        toolName: trimmedToolName,
        params: params as Record<string, unknown>
      };
    }

    case "ask_approval": {
      const ap = record.approvalPlan;
      if (!ap || typeof ap !== "object" || Array.isArray(ap)) {
        throw new AgentValidationError(
          "'approvalPlan' object is required when decisionType is 'ask_approval'."
        );
      }
      const planObj = ap as Record<string, unknown>;
      const description = planObj.description;
      if (typeof description !== "string" || !description.trim()) {
        throw new AgentValidationError("approvalPlan.description must be a non-empty string.");
      }

      const actions = planObj.proposedActions;
      if (actions !== undefined && !Array.isArray(actions)) {
        throw new AgentValidationError("approvalPlan.proposedActions must be an array.");
      }

      const validatedActions: AgentApprovalPlan["proposedActions"] = [];
      if (Array.isArray(actions)) {
        for (let i = 0; i < actions.length; i++) {
          const act = actions[i];
          if (!act || typeof act !== "object" || Array.isArray(act)) {
            throw new AgentValidationError(`proposedActions[${i}] must be an object.`);
          }
          const actObj = act as Record<string, unknown>;
          if (typeof actObj.toolName !== "string" || !actObj.toolName.trim()) {
            throw new AgentValidationError(`proposedActions[${i}].toolName must be a non-empty string.`);
          }
          const actionToolName = actObj.toolName.trim();
          const isRegistered = toolRegistry ? toolRegistry.hasTool(actionToolName) : true;
          const isSupportedEditingOp = (SUPPORTED_PROPOSED_OPERATIONS as readonly string[]).includes(actionToolName);

          if (!isRegistered && !isSupportedEditingOp) {
            throw new AgentSecurityError(
              `Proposed action references unallowlisted tool '${actionToolName}'.`
            );
          }

          let actParams = actObj.params ?? {};
          if (typeof actParams === "string") {
            try {
              actParams = JSON.parse(actParams);
            } catch {
              throw new AgentValidationError(
                `Invalid JSON string for params in proposed action '${actionToolName}'.`
              );
            }
          }
          if (typeof actParams !== "object" || Array.isArray(actParams)) {
            throw new AgentValidationError(`params must be an object in proposed action '${actionToolName}'.`);
          }

          validatedActions.push({
            toolName: actionToolName,
            params: actParams as Record<string, unknown>,
            description: typeof actObj.description === "string" ? actObj.description.trim() : undefined
          });
        }
      }

      let validatedEditingPlan: AgentEditingPlan | undefined = undefined;
      if (planObj.editingPlan) {
        if (
          typeof planObj.editingPlan === "object" &&
          planObj.editingPlan !== null &&
          "status" in planObj.editingPlan
        ) {
          const suppliedStatus = (planObj.editingPlan as Record<string, unknown>).status;
          if (suppliedStatus !== undefined && suppliedStatus !== null && suppliedStatus !== "proposed") {
            throw new AgentValidationError(
              `Model-generated editing plan cannot self-assign status '${String(suppliedStatus)}'. Only 'proposed' status is allowed.`
            );
          }
        }
        validatedEditingPlan = validateEditingPlan(planObj.editingPlan);
        validatedEditingPlan.status = "proposed";
      } else if (validatedActions.length > 0) {
        const ops = validatedActions
          .filter((a) => (SUPPORTED_PROPOSED_OPERATIONS as readonly string[]).includes(a.toolName))
          .map((a, idx) => ({
            id: `op-${idx + 1}`,
            type: a.toolName as ProposedOperationType,
            description: a.description || `Proposed ${a.toolName}`,
            params: a.params,
            assetId: typeof a.params.assetId === "string" ? a.params.assetId : undefined,
            clipId: typeof a.params.clipId === "string" ? a.params.clipId : undefined,
            trackId: typeof a.params.trackId === "string" ? a.params.trackId : undefined,
            timeRange: typeof a.params.timeRange === "object" ? (a.params.timeRange as any) : undefined
          }));

        if (ops.length > 0) {
          validatedEditingPlan = {
            id: crypto.randomUUID(),
            requestId: crypto.randomUUID(),
            projectId: "default",
            summary: description.trim(),
            operations: ops,
            status: "proposed",
            createdAt: new Date().toISOString()
          };
        }
      }

      return {
        type: "ask_approval",
        plan: {
          description: description.trim(),
          proposedActions: validatedActions,
          estimatedImpact:
            typeof planObj.estimatedImpact === "string" ? planObj.estimatedImpact.trim() : undefined,
          editingPlan: validatedEditingPlan
        },
        editingPlan: validatedEditingPlan
      };
    }

    case "finish": {
      const res = record.result;
      if (res && (typeof res !== "object" || Array.isArray(res))) {
        throw new AgentValidationError("result must be an object when decisionType is 'finish'.");
      }
      const resObj = res as Record<string, unknown> | undefined;
      const summary =
        typeof resObj?.summary === "string"
          ? resObj.summary.trim()
          : typeof record.explanation === "string"
          ? record.explanation.trim()
          : undefined;

      const finishResult: AgentResult = {};
      if (summary) finishResult.summary = summary;
      if (resObj?.output && typeof resObj.output === "object" && !Array.isArray(resObj.output)) {
        finishResult.output = resObj.output as Record<string, unknown>;
      }

      return {
        type: "finish",
        result: finishResult
      };
    }

    case "fail": {
      const reason =
        typeof record.failureReason === "string" && record.failureReason.trim()
          ? record.failureReason.trim()
          : typeof record.explanation === "string" && record.explanation.trim()
          ? record.explanation.trim()
          : "Agent execution failed.";

      return {
        type: "fail",
        error: reason
      };
    }
  }
}

