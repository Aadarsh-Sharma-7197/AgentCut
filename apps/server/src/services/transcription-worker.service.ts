import { spawn, ChildProcess } from "child_process";
import readline from "readline";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { getWhisperModelsDir } from "../config/storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: NodeJS.Timeout;
}

export interface WorkerProbeResult {
  success: boolean;
  cuda_available: boolean;
  cuda_device_count: number;
  device_name: string;
  supported_compute_types_cpu: string[];
  supported_compute_types_cuda: string[];
  ctranslate2_version: string;
  faster_whisper_version: string;
  error?: string;
}

export interface WorkerTranscribeResult {
  id: string;
  type: string;
  success: boolean;
  language?: string;
  language_probability?: number;
  duration?: number;
  segment_count?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    words?: Array<{
      word: string;
      start: number;
      end: number;
      probability?: number;
    }>;
  }>;
  text?: string;
  execution_device?: "cuda" | "cpu";
  compute_type?: string;
  model_name?: string;
  error?: string;
  can_retry_cpu?: boolean;
}

let workerProcess: ChildProcess | null = null;
let rl: readline.Interface | null = null;
const pendingRequests = new Map<string, PendingRequest>();
let isShuttingDown = false;

// Mock hook for deterministic lifecycle & error testing
type MockWorkerFn = (req: any) => Promise<any> | null;
let mockWorkerFn: MockWorkerFn | null = null;

export function setMockWorkerHandler(fn: MockWorkerFn | null): void {
  mockWorkerFn = fn;
}

function findWorkerDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "apps", "transcription-worker"),
    path.resolve(process.cwd(), "..", "transcription-worker"),
    path.resolve(process.cwd(), "transcription-worker"),
    path.resolve(__dirname, "..", "..", "..", "apps", "transcription-worker"),
    path.resolve(__dirname, "..", "..", "transcription-worker"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, "worker.py"))) {
      return c;
    }
  }

  let curr = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(curr, "apps", "transcription-worker");
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "worker.py"))) {
      return candidate;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  return path.resolve(process.cwd(), "apps", "transcription-worker");
}

export function getPythonPath(): string {
  if (process.env.TRANSCRIPTION_PYTHON_PATH) {
    return path.resolve(process.env.TRANSCRIPTION_PYTHON_PATH);
  }

  const workerDir = findWorkerDir();
  const winVenv = path.join(workerDir, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(winVenv)) {
    return winVenv;
  }

  const unixVenv = path.join(workerDir, ".venv", "bin", "python");
  if (fs.existsSync(unixVenv)) {
    return unixVenv;
  }

  return "python";
}

export function getWorkerScriptPath(): string {
  const workerDir = findWorkerDir();
  const scriptPath = path.join(workerDir, "worker.py");
  if (fs.existsSync(scriptPath)) {
    return scriptPath;
  }
  throw new Error(`Worker script not found at expected path: ${scriptPath}`);
}

/**
 * Ensures the Python worker process is running and responsive.
 */
export async function ensureWorkerRunning(): Promise<ChildProcess> {
  if (mockWorkerFn) {
    return {} as ChildProcess;
  }

  if (workerProcess && !workerProcess.killed && workerProcess.exitCode === null) {
    return workerProcess;
  }

  const pythonBin = getPythonPath();
  const scriptPath = getWorkerScriptPath();

  console.log(`[TranscriptionWorkerManager] Spawning worker: ${pythonBin} ${scriptPath}`);

  const proc = spawn(pythonBin, [scriptPath], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1"
    }
  });

  workerProcess = proc;

  if (!proc.stdout || !proc.stdin || !proc.stderr) {
    throw new Error("Failed to attach stdio pipes to transcription worker process.");
  }

  rl = readline.createInterface({
    input: proc.stdout,
    crlfDelay: Infinity
  });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: any;
    try {
      parsed = jsonParseSafe(trimmed);
    } catch {
      console.warn(`[TranscriptionWorkerManager] Received non-JSON output from worker: ${trimmed}`);
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const id = parsed.id;
    if (id && pendingRequests.has(id)) {
      const pending = pendingRequests.get(id)!;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(parsed);
    } else if (parsed.type === "error" && !id) {
      console.warn(`[TranscriptionWorkerManager] Unmatched worker error: ${parsed.error}`);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    // Forward stderr diagnostic logs
    process.stderr.write(chunk);
  });

  proc.on("error", (err) => {
    console.error("[TranscriptionWorkerManager] Worker process error:", err);
    cleanupPendingRequests(new Error(`Transcription worker process error: ${err.message}`));
    workerProcess = null;
  });

  proc.on("close", (code) => {
    console.log(`[TranscriptionWorkerManager] Worker process exited with code ${code}`);
    cleanupPendingRequests(new Error(`Transcription worker process terminated unexpectedly (code: ${code}).`));
    workerProcess = null;
  });

  // Verify worker readiness with ping
  try {
    await sendRequestToWorker({ id: `ping-${Date.now()}`, type: "ping" }, 5000);
  } catch (err) {
    if (workerProcess) {
      try { workerProcess.kill("SIGKILL"); } catch {}
      workerProcess = null;
    }
    throw new Error(`Worker readiness check failed: ${err instanceof Error ? err.message : "Unknown error"}`);
  }

  return proc;
}

function jsonParseSafe(str: string): any {
  return JSON.parse(str);
}

function cleanupPendingRequests(reason: Error) {
  for (const [id, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timer);
    pending.reject(reason);
  }
  pendingRequests.clear();
}

/**
 * Sends a JSON request line to the worker and awaits its matching JSON response.
 */
export async function sendRequestToWorker(req: any, timeoutMs = 300000): Promise<any> {
  if (mockWorkerFn) {
    const mockRes = await mockWorkerFn(req);
    if (mockRes) return mockRes;
  }

  await ensureWorkerRunning();

  if (!workerProcess || !workerProcess.stdin || workerProcess.killed) {
    throw new Error("Worker process is not available.");
  }

  const reqId = req.id || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.id = reqId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error(`Request '${reqId}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    pendingRequests.set(reqId, { resolve, reject, timer });

    try {
      const line = JSON.stringify(req) + "\n";
      workerProcess!.stdin!.write(line);
    } catch (writeErr) {
      clearTimeout(timer);
      pendingRequests.delete(reqId);
      reject(new Error(`Failed to write to worker stdin: ${writeErr instanceof Error ? writeErr.message : "Unknown error"}`));
    }
  });
}

/**
 * Probes the hardware and CTranslate2 capabilities.
 */
export async function probeWorkerHardware(): Promise<WorkerProbeResult> {
  const reqId = `probe-${Date.now()}`;
  return sendRequestToWorker({ id: reqId, type: "probe" }, 15000);
}

/**
 * Executes audio transcription through the worker process.
 */
export async function executeWorkerTranscription(options: {
  audioPath: string;
  modelName: "small" | "base";
  languageHint?: string;
  device?: "auto" | "cuda" | "cpu";
  computeType?: string;
  wordTimestamps?: boolean;
}): Promise<WorkerTranscribeResult> {
  const reqId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const downloadRoot = getWhisperModelsDir();

  const req = {
    id: reqId,
    type: "transcribe",
    audio_path: options.audioPath,
    model_name: options.modelName,
    language: options.languageHint || null,
    device: options.device || "auto",
    compute_type: options.computeType || "auto",
    word_timestamps: options.wordTimestamps !== false,
    download_root: downloadRoot
  };

  return sendRequestToWorker(req, 600000); // 10 minute timeout for large audio
}

/**
 * Gracefully shuts down the worker process.
 */
export async function stopWorker(): Promise<void> {
  if (workerProcess && !workerProcess.killed) {
    isShuttingDown = true;
    try {
      await sendRequestToWorker({ id: `exit-${Date.now()}`, type: "exit" }, 3000);
    } catch {}

    if (workerProcess && !workerProcess.killed) {
      try {
        workerProcess.kill("SIGKILL");
      } catch {}
    }
    workerProcess = null;
    isShuttingDown = false;
  }
}

export function isWorkerAlive(): boolean {
  return Boolean(workerProcess && !workerProcess.killed && workerProcess.exitCode === null);
}

export function registerTranscriptionWorkerShutdownHooks(): void {
  const cleanup = () => {
    if (workerProcess && !workerProcess.killed) {
      try {
        workerProcess.kill("SIGKILL");
      } catch {}
      workerProcess = null;
    }
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
}
