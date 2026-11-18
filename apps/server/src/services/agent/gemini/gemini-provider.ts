import { GoogleGenAI } from "@google/genai";
import type { AgentStepDecision } from "@agentcut/shared";
import type { AgentPlanProvider, AgentExecutionContext } from "../agent-context.js";
import type { AgentToolRegistry } from "../agent-tools.js";
import { type GeminiConfig } from "../../../config/gemini.config.js";
import {
  GEMINI_AGENT_DECISION_SCHEMA,
  MAX_GEMINI_RESPONSE_BYTES,
  validateGeminiDecision
} from "./gemini-schema.js";
import { buildGeminiPrompt, redactSensitiveText } from "./gemini-prompt.js";
import {
  AgentValidationError,
  AgentSecurityError,
  AgentTimeoutError,
  AgentCancellationError
} from "../agent-errors.js";

export interface GeminiClientLike {
  models: {
    generateContent(params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }): Promise<{ text?: string | null }>;
  };
}

export class GeminiPlanProvider implements AgentPlanProvider {
  private readonly client: GeminiClientLike;

  constructor(
    private readonly config: GeminiConfig,
    private readonly toolRegistry: AgentToolRegistry,
    client?: GeminiClientLike
  ) {
    this.client = (client ?? new GoogleGenAI({ apiKey: config.apiKey })) as unknown as GeminiClientLike;
  }

  public async generateStep(context: AgentExecutionContext): Promise<AgentStepDecision> {
    context.checkCancellation();

    const { systemInstruction, userContent } = buildGeminiPrompt(
      context,
      this.toolRegistry
    );

    let timeoutTimer: NodeJS.Timeout | null = null;

    try {
      // Build a promise with timeout and cancellation races
      const generatePromise = this.client.models.generateContent({
        model: this.config.model,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: GEMINI_AGENT_DECISION_SCHEMA,
          maxOutputTokens: this.config.maxOutputTokens,
          temperature: this.config.temperature
        }
      });

      const abortPromise = new Promise<never>((_, reject) => {
        if (context.signal.aborted) {
          reject(new AgentCancellationError());
          return;
        }
        context.signal.addEventListener(
          "abort",
          () => reject(new AgentCancellationError()),
          { once: true }
        );
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          reject(new AgentTimeoutError(this.config.timeoutMs));
        }, this.config.timeoutMs);
      });

      const response = await Promise.race([
        generatePromise,
        abortPromise,
        timeoutPromise
      ]);

      context.checkCancellation();

      const rawText = response.text;
      if (!rawText || typeof rawText !== "string") {
        throw new AgentValidationError("Gemini returned an empty response.");
      }

      const byteLength = Buffer.byteLength(rawText, "utf8");
      if (byteLength > MAX_GEMINI_RESPONSE_BYTES) {
        throw new AgentValidationError(
          `Gemini response exceeded maximum response byte limit of ${MAX_GEMINI_RESPONSE_BYTES} bytes (received ${byteLength} bytes).`
        );
      }

      if (rawText.trim().length === 0) {
        throw new AgentValidationError("Gemini returned an empty response.");
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText.trim());
      } catch (parseErr) {
        const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        throw new AgentValidationError(
          `Malformed JSON returned by Gemini: ${redactSensitiveText(parseMsg)}`
        );
      }

      return validateGeminiDecision(parsedJson, this.toolRegistry);
    } catch (err) {
      if (err instanceof AgentCancellationError || context.signal.aborted) {
        throw new AgentCancellationError();
      }

      if (err instanceof AgentTimeoutError) {
        throw err;
      }

      if (err instanceof AgentValidationError || err instanceof AgentSecurityError) {
        return {
          type: "fail",
          error: redactSensitiveText(err.message)
        };
      }

      const rawMsg = err instanceof Error ? err.message : String(err);
      const sanitized = redactSensitiveText(rawMsg);

      // Check for rate limits / quotas (429, RESOURCE_EXHAUSTED)
      if (
        sanitized.includes("429") ||
        sanitized.toLowerCase().includes("quota") ||
        sanitized.toLowerCase().includes("rate limit") ||
        sanitized.includes("RESOURCE_EXHAUSTED")
      ) {
        return {
          type: "fail",
          error: "Gemini provider rate limit exceeded. Please retry later."
        };
      }

      // Check for network errors or provider unavailable
      if (
        sanitized.includes("ECONNREFUSED") ||
        sanitized.includes("ETIMEDOUT") ||
        sanitized.includes("ENOTFOUND") ||
        sanitized.includes("503") ||
        sanitized.includes("UNAVAILABLE")
      ) {
        return {
          type: "fail",
          error: "Gemini provider is currently unavailable. Please check your network connection."
        };
      }

      console.error("[GeminiPlanProvider] Provider invocation error:", sanitized);
      return {
        type: "fail",
        error: `Gemini provider error: ${sanitized}`
      };
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  }
}
