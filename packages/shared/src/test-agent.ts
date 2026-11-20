import {
  type AgentRequestStatus,
  VALID_STATUS_TRANSITIONS,
  isValidAgentStatusTransition,
  AGENT_SAFETY_LIMITS
} from "./index.js";

export function runAgentTests(): { passed: number; failed: number } {
  console.log("\n=== Agent Runtime Shared Contracts Test Suite ===");
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ""}`);
      failed++;
    }
  }

  // 1. Safety Limit Constants
  assert(AGENT_SAFETY_LIMITS.DEFAULT_MAX_ITERATIONS === 10, "Default maxIterations is 10");
  assert(AGENT_SAFETY_LIMITS.MIN_MAX_ITERATIONS === 1, "Min maxIterations is 1");
  assert(AGENT_SAFETY_LIMITS.MAX_MAX_ITERATIONS === 50, "Max maxIterations is 50");
  assert(AGENT_SAFETY_LIMITS.DEFAULT_MAX_TOOL_CALLS === 25, "Default maxToolCalls is 25");
  assert(AGENT_SAFETY_LIMITS.MIN_MAX_TOOL_CALLS === 1, "Min maxToolCalls is 1");
  assert(AGENT_SAFETY_LIMITS.MAX_MAX_TOOL_CALLS === 100, "Max maxToolCalls is 100");
  assert(AGENT_SAFETY_LIMITS.DEFAULT_TIMEOUT_MS === 60000, "Default timeoutMs is 60000ms");
  assert(AGENT_SAFETY_LIMITS.MIN_TIMEOUT_MS === 1000, "Min timeoutMs is 1000ms");
  assert(AGENT_SAFETY_LIMITS.MAX_TIMEOUT_MS === 300000, "Max timeoutMs is 300000ms");
  assert(AGENT_SAFETY_LIMITS.MAX_PROMPT_LENGTH === 4000, "Max prompt length is 4000 characters");

  // 2. Valid Lifecycle Transitions
  assert(isValidAgentStatusTransition("queued", "processing"), "queued -> processing is valid");
  assert(isValidAgentStatusTransition("queued", "canceled"), "queued -> canceled is valid");
  assert(isValidAgentStatusTransition("processing", "awaiting_approval"), "processing -> awaiting_approval is valid");
  assert(isValidAgentStatusTransition("processing", "completed"), "processing -> completed is valid");
  assert(isValidAgentStatusTransition("processing", "failed"), "processing -> failed is valid");
  assert(isValidAgentStatusTransition("processing", "canceled"), "processing -> canceled is valid");
  assert(isValidAgentStatusTransition("awaiting_approval", "executing"), "awaiting_approval -> executing is valid");
  assert(isValidAgentStatusTransition("awaiting_approval", "processing"), "awaiting_approval -> processing is valid");
  assert(isValidAgentStatusTransition("awaiting_approval", "completed"), "awaiting_approval -> completed is valid");
  assert(isValidAgentStatusTransition("awaiting_approval", "failed"), "awaiting_approval -> failed is valid");
  assert(isValidAgentStatusTransition("awaiting_approval", "canceled"), "awaiting_approval -> canceled is valid");
  assert(isValidAgentStatusTransition("executing", "completed"), "executing -> completed is valid");
  assert(isValidAgentStatusTransition("executing", "failed"), "executing -> failed is valid");
  assert(isValidAgentStatusTransition("executing", "canceled"), "executing -> canceled is valid");

  // 3. Invalid Lifecycle Transitions (Strict Rejection)
  assert(!isValidAgentStatusTransition("queued", "completed"), "queued -> completed is INVALID");
  assert(!isValidAgentStatusTransition("queued", "failed"), "queued -> failed is INVALID");
  assert(!isValidAgentStatusTransition("queued", "awaiting_approval"), "queued -> awaiting_approval is INVALID");
  assert(!isValidAgentStatusTransition("queued", "executing"), "queued -> executing is INVALID");
  assert(!isValidAgentStatusTransition("executing", "queued"), "executing -> queued is INVALID");
  assert(!isValidAgentStatusTransition("executing", "processing"), "executing -> processing is INVALID");
  assert(!isValidAgentStatusTransition("executing", "awaiting_approval"), "executing -> awaiting_approval is INVALID");

  // Terminal state: completed
  assert(!isValidAgentStatusTransition("completed", "queued"), "completed -> queued is INVALID");
  assert(!isValidAgentStatusTransition("completed", "processing"), "completed -> processing is INVALID");
  assert(!isValidAgentStatusTransition("completed", "awaiting_approval"), "completed -> awaiting_approval is INVALID");
  assert(!isValidAgentStatusTransition("completed", "failed"), "completed -> failed is INVALID");
  assert(!isValidAgentStatusTransition("completed", "canceled"), "completed -> canceled is INVALID");

  // Terminal state: failed
  assert(!isValidAgentStatusTransition("failed", "queued"), "failed -> queued is INVALID");
  assert(!isValidAgentStatusTransition("failed", "processing"), "failed -> processing is INVALID");
  assert(!isValidAgentStatusTransition("failed", "awaiting_approval"), "failed -> awaiting_approval is INVALID");
  assert(!isValidAgentStatusTransition("failed", "completed"), "failed -> completed is INVALID");
  assert(!isValidAgentStatusTransition("failed", "canceled"), "failed -> canceled is INVALID");

  // Terminal state: canceled
  assert(!isValidAgentStatusTransition("canceled", "queued"), "canceled -> queued is INVALID");
  assert(!isValidAgentStatusTransition("canceled", "processing"), "canceled -> processing is INVALID");
  assert(!isValidAgentStatusTransition("canceled", "awaiting_approval"), "canceled -> awaiting_approval is INVALID");
  assert(!isValidAgentStatusTransition("canceled", "completed"), "canceled -> completed is INVALID");
  assert(!isValidAgentStatusTransition("canceled", "failed"), "canceled -> failed is INVALID");

  return { passed, failed };
}

