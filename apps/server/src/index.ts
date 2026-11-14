import express from "express";
import { AGENTCUT_VERSION, type HealthStatus } from "@agentcut/shared";

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

app.get("/health", (_req, res) => {
  const health: HealthStatus = {
    status: "ok",
    timestamp: new Date().toISOString()
  };
  res.json({
    ...health,
    version: AGENTCUT_VERSION,
    service: "server"
  });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default app;

