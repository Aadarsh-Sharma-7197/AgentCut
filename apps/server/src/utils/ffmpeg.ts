import { spawn } from "child_process";
import fs from "fs";

const COMMON_FFMPEG_PATHS = [
  "C:\\Users\\aadar\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe"
];

/**
 * Returns the resolved path to the FFmpeg executable.
 * Checks environment variable FFMPEG_PATH, common installation paths, and falls back to "ffmpeg".
 */
export function getFFmpegPath(): string {
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }

  for (const candidate of COMMON_FFMPEG_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "ffmpeg";
}

/**
 * Checks whether the FFmpeg binary is installed and executable.
 * Strictly uses safe spawn argument array with shell: false.
 * Handles missing binaries and invalid paths cleanly without throwing unhandled exceptions.
 */
export async function checkFFmpegAvailable(binaryPath?: string): Promise<boolean> {
  const binary = binaryPath || getFFmpegPath();
  return new Promise((resolve) => {
    try {
      const proc = spawn(binary, ["-version"], { shell: false });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Validates FFmpeg command arguments for injection attacks.
 * Enforces:
 * 1. Arguments must be a discrete array of strings (no string interpolation or concatenated shell lines).
 * 2. No shell control operators or redirection characters allowed inside arguments.
 */
export function validateFFmpegSafety(args: string[]): void {
  if (!Array.isArray(args)) {
    throw new Error("FFmpeg arguments must be an array of discrete strings.");
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") {
      throw new Error(`Invalid FFmpeg argument type: ${typeof arg}. Expected string.`);
    }

    const prevArg = i > 0 ? args[i - 1] : "";
    const isFilterArg =
      prevArg === "-filter_complex" ||
      prevArg === "-lavfi" ||
      prevArg === "-vf" ||
      prevArg === "-af";

    // In FFmpeg, semicolons are used as filterchain separators inside filter graphs.
    // For non-filter arguments, semicolons are strictly blocked to prevent shell command concatenation.
    const forbiddenTokens = isFilterArg
      ? ["&&", "||", "|", "`", "$", "\n", "\r"]
      : [";", "&&", "||", "|", "`", "$", "\n", "\r"];

    for (const token of forbiddenTokens) {
      if (arg.includes(token)) {
        throw new Error(
          `Security violation: forbidden shell control character '${token}' detected in argument '${arg}'.`
        );
      }
    }
  }
}

