import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from both cwd and apps/server package directory for reliable monorepo execution
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(process.cwd(), "apps/server/.env") });

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { AGENTCUT_VERSION, type HealthStatus } from "@agentcut/shared";
import { connectDB } from "./config/db.js";
import { initMediaIndexes } from "./services/media.service.js";
import { initTimelineIndexes } from "./services/timeline.service.js";
import { initRenderJobIndexes } from "./services/render-job.service.js";
import { registerPipelineShutdownHooks } from "./services/render-pipeline.service.js";
import {
  initAudioExtractionIndexes,
  registerAudioExtractionShutdownHooks
} from "./services/audio-extraction.service.js";
import {
  initSilenceDetectionIndexes,
  registerSilenceDetectionShutdownHooks
} from "./services/silence-detection.service.js";
import { projectRouter } from "./routes/project.routes.js";

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get("/health", (_req: Request, res: Response) => {
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

// Project Management API Routes
app.use("/api/projects", projectRouter);

// 404 Handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
});

// Centralized Error Handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const errorObj = err as { status?: number; statusCode?: number; message?: string };
  if (errorObj && (errorObj.status === 400 || errorObj.statusCode === 400)) {
    res.status(400).json({ error: "Malformed request payload." });
    return;
  }
  console.error("[ServerError]", err);
  res.status(500).json({ error: "An unexpected error occurred" });
});

export async function startServer() {
  try {
    await connectDB();
    await initMediaIndexes();
    await initTimelineIndexes();
    await initRenderJobIndexes();
    await initAudioExtractionIndexes();
    await initSilenceDetectionIndexes();
    registerPipelineShutdownHooks();
    registerAudioExtractionShutdownHooks();
    registerSilenceDetectionShutdownHooks();
    const server = app.listen(port, () => {
      console.log(`[Server] AgentCut API running on http://localhost:${port}`);
    });
    return server;
  } catch (err) {
    console.error("[Server] Fatal startup error: Could not connect to MongoDB.", err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}

export default app;
