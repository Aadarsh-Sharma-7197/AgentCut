import { AgentSecurityError } from "./agent-errors.js";
import type { AgentExecutionContext } from "./agent-context.js";

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  validate(input: unknown): TInput;
  execute(input: TInput, context: AgentExecutionContext): Promise<TOutput>;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool<any, any>>();

  public registerTool(tool: AgentTool<any, any>): void {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
      throw new AgentSecurityError("Invalid tool definition: name is required.");
    }
    const sanitizedName = tool.name.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitizedName)) {
      throw new AgentSecurityError(
        `Invalid tool name '${tool.name}'. Only alphanumeric characters, dashes, and underscores are allowed.`
      );
    }
    if (this.tools.has(sanitizedName)) {
      throw new AgentSecurityError(`Tool '${sanitizedName}' is already registered.`);
    }
    this.tools.set(sanitizedName, tool);
  }

  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  public getTool(name: string): AgentTool<any, any> | undefined {
    return this.tools.get(name);
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  public listTools(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description
    }));
  }

  public clear(): void {
    this.tools.clear();
  }
}

