import { AgentToolRegistry } from "../agent-tools.js";
import { getProjectContextTool } from "./project-context.tool.js";
import { listProjectAssetsTool } from "./list-assets.tool.js";
import { getTimelineTool } from "./get-timeline.tool.js";
import { searchSpeechTool } from "./search-speech.tool.js";
import { searchSilenceTool } from "./search-silence.tool.js";
import { searchScenesTool } from "./search-scenes.tool.js";

export * from "./project-context.tool.js";
export * from "./list-assets.tool.js";
export * from "./get-timeline.tool.js";
export * from "./search-speech.tool.js";
export * from "./search-silence.tool.js";
export * from "./search-scenes.tool.js";

export function createReadOnlyToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.registerTool(getProjectContextTool);
  registry.registerTool(listProjectAssetsTool);
  registry.registerTool(getTimelineTool);
  registry.registerTool(searchSpeechTool);
  registry.registerTool(searchSilenceTool);
  registry.registerTool(searchScenesTool);
  return registry;
}

