import { AGENTCUT_VERSION } from "@agentcut/shared";

export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>AgentCut</h1>
      <p>AI-Native Video Editing Agent</p>
      <small>Version: {AGENTCUT_VERSION}</small>
    </main>
  );
}

