export interface GeminiConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
}

export class GeminiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiConfigurationError";
  }
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_GEMINI_TIMEOUT_MS = 30000;

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

export function getGeminiConfig(overrides?: Partial<GeminiConfig>): GeminiConfig {
  const apiKey = overrides?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new GeminiConfigurationError(
      "Gemini API key is missing. Please set GEMINI_API_KEY in your environment."
    );
  }

  const model = overrides?.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  if (typeof model !== "string" || !model.trim()) {
    throw new GeminiConfigurationError("Gemini model configuration cannot be empty.");
  }

  const sanitizedModel = model.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(sanitizedModel)) {
    throw new GeminiConfigurationError(
      `Invalid Gemini model identifier '${sanitizedModel}'. Only alphanumeric characters, dots, dashes, and underscores are allowed.`
    );
  }

  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  const envTokens = process.env.GEMINI_MAX_OUTPUT_TOKENS;
  if (overrides?.maxOutputTokens !== undefined) {
    maxOutputTokens = overrides.maxOutputTokens;
  } else if (envTokens) {
    const parsed = parseInt(envTokens, 10);
    if (Number.isFinite(parsed) && parsed >= 256 && parsed <= 8192) {
      maxOutputTokens = parsed;
    }
  }

  let temperature = DEFAULT_TEMPERATURE;
  const envTemp = process.env.GEMINI_TEMPERATURE;
  if (overrides?.temperature !== undefined) {
    temperature = overrides.temperature;
  } else if (envTemp) {
    const parsed = parseFloat(envTemp);
    if (Number.isFinite(parsed) && parsed >= 0.0 && parsed <= 2.0) {
      temperature = parsed;
    }
  }

  let timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS;
  const envTimeout = process.env.GEMINI_TIMEOUT_MS;
  if (overrides?.timeoutMs !== undefined) {
    timeoutMs = overrides.timeoutMs;
  } else if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 120000) {
      timeoutMs = parsed;
    }
  }

  return {
    apiKey: apiKey.trim(),
    model: sanitizedModel,
    maxOutputTokens,
    temperature,
    timeoutMs
  };
}

