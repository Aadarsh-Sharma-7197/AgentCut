import { spawn } from "child_process";
import fs from "fs";

export interface FFprobeMetadata {
  duration: number;
  width: number;
  height: number;
  frameRate: string;
  videoCodec: string;
  audioCodec: string | null;
  format: string;
  fileSize: number;
}

export interface FFprobeAudioMetadata {
  format: string;
  codec: string;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  duration: number;
  fileSize: number;
}

const COMMON_FFPROBE_PATHS = [
  "C:\\Users\\aadar\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffprobe.exe"
];

export function getFFprobePath(): string {
  if (process.env.FFPROBE_PATH) {
    return process.env.FFPROBE_PATH;
  }

  // Check common win-get install locations if present
  for (const candidate of COMMON_FFPROBE_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "ffprobe";
}

export async function checkFFprobeAvailable(): Promise<boolean> {
  const binary = getFFprobePath();
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

interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  bits_per_sample?: number;
  bits_per_raw_sample?: string | number;
}

interface FFprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
}

interface FFprobeOutput {
  streams?: FFprobeStream[];
  format?: FFprobeFormat;
}

export async function inspectVideo(filePath: string): Promise<FFprobeMetadata> {
  const binary = getFFprobePath();

  const isAvailable = await checkFFprobeAvailable();
  if (!isAvailable) {
    throw new Error(
      `FFprobe executable not found or not runnable (tried: ${binary}). ` +
        `Please ensure FFprobe is installed or set FFPROBE_PATH in your environment.`
    );
  }

  const args = [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-print_format",
    "json",
    filePath
  ];

  return new Promise<FFprobeMetadata>((resolve, reject) => {
    const proc = spawn(binary, args, { shell: false });
    let stdoutData = "";
    let stderrData = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn FFprobe process: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `FFprobe exited with code ${code}. ${stderrData.trim() || "Invalid or corrupt media file."}`
          )
        );
      }

      let parsed: FFprobeOutput;
      try {
        parsed = JSON.parse(stdoutData) as FFprobeOutput;
      } catch (parseErr) {
        return reject(
          new Error(`Failed to parse FFprobe JSON output: ${parseErr instanceof Error ? parseErr.message : "Unknown error"}`)
        );
      }

      const streams = parsed.streams || [];
      const videoStream = streams.find((s) => s.codec_type === "video");
      const audioStream = streams.find((s) => s.codec_type === "audio");

      if (!videoStream) {
        return reject(
          new Error("The uploaded file does not contain a valid video stream (audio-only or non-video files are not supported).")
        );
      }

      // Calculate or parse duration
      let duration = 0;
      if (parsed.format?.duration) {
        duration = parseFloat(parsed.format.duration);
      } else if (videoStream.duration) {
        duration = parseFloat(videoStream.duration);
      }

      if (isNaN(duration) || duration < 0) {
        duration = 0;
      }

      // Calculate file size
      let fileSize = 0;
      if (parsed.format?.size) {
        fileSize = parseInt(parsed.format.size, 10);
      }
      if (isNaN(fileSize) || fileSize <= 0) {
        try {
          const stats = fs.statSync(filePath);
          fileSize = stats.size;
        } catch {
          fileSize = 0;
        }
      }

      // Calculate frame rate
      let frameRate = videoStream.avg_frame_rate || videoStream.r_frame_rate || "unknown";
      if (frameRate.includes("/")) {
        const [numStr, denStr] = frameRate.split("/");
        const num = parseFloat(numStr);
        const den = parseFloat(denStr);
        if (den && den > 0 && !isNaN(num) && !isNaN(den)) {
          frameRate = (num / den).toFixed(2);
        }
      }

      resolve({
        duration: Math.round(duration * 100) / 100, // round to 2 decimal places
        width: videoStream.width || 0,
        height: videoStream.height || 0,
        frameRate,
        videoCodec: videoStream.codec_name || "unknown",
        audioCodec: audioStream?.codec_name || null,
        format: parsed.format?.format_name || "unknown",
        fileSize
      });
    });
  });
}

/**
 * Validates and inspects an extracted audio WAV file using FFprobe.
 * Verifies that the file is a valid WAV containing a mono, 16kHz, pcm_s16le audio stream.
 */
export async function inspectAudioFile(filePath: string): Promise<FFprobeAudioMetadata> {
  const binary = getFFprobePath();

  const isAvailable = await checkFFprobeAvailable();
  if (!isAvailable) {
    throw new Error(
      `FFprobe executable not found or not runnable (tried: ${binary}). ` +
        `Please ensure FFprobe is installed or set FFPROBE_PATH in your environment.`
    );
  }

  const args = [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-print_format",
    "json",
    filePath
  ];

  return new Promise<FFprobeAudioMetadata>((resolve, reject) => {
    const proc = spawn(binary, args, { shell: false });
    let stdoutData = "";
    let stderrData = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn FFprobe process: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `FFprobe exited with code ${code}. ${stderrData.trim() || "Invalid or corrupt audio file."}`
          )
        );
      }

      let parsed: FFprobeOutput;
      try {
        parsed = JSON.parse(stdoutData) as FFprobeOutput;
      } catch (parseErr) {
        return reject(
          new Error(`Failed to parse FFprobe JSON output: ${parseErr instanceof Error ? parseErr.message : "Unknown error"}`)
        );
      }

      const streams = parsed.streams || [];
      const audioStream = streams.find((s) => s.codec_type === "audio");

      if (!audioStream) {
        return reject(new Error("The extracted file does not contain an audio stream."));
      }

      // Check format
      const formatName = parsed.format?.format_name?.toLowerCase() || "";
      if (!formatName.includes("wav")) {
        return reject(new Error(`Expected WAV format but FFprobe reported '${formatName}'.`));
      }

      // Check codec
      const codec = audioStream.codec_name || "";
      if (codec !== "pcm_s16le") {
        return reject(new Error(`Expected pcm_s16le audio codec but FFprobe reported '${codec}'.`));
      }

      // Check channels
      const channels = audioStream.channels ?? 0;
      if (channels !== 1) {
        return reject(new Error(`Expected mono (1 channel) audio but FFprobe reported ${channels} channels.`));
      }

      // Check sample rate
      const sampleRate = parseInt(audioStream.sample_rate || "0", 10);
      if (sampleRate !== 16000) {
        return reject(new Error(`Expected 16,000 Hz sample rate but FFprobe reported ${sampleRate} Hz.`));
      }

      // Bit depth
      let bitDepth = audioStream.bits_per_sample || 16;
      if (!bitDepth && audioStream.bits_per_raw_sample) {
        bitDepth = parseInt(String(audioStream.bits_per_raw_sample), 10) || 16;
      }

      // Duration
      let duration = 0;
      if (parsed.format?.duration) {
        duration = parseFloat(parsed.format.duration);
      } else if (audioStream.duration) {
        duration = parseFloat(audioStream.duration);
      }
      if (isNaN(duration) || duration < 0) {
        duration = 0;
      }

      // File size
      let fileSize = 0;
      if (parsed.format?.size) {
        fileSize = parseInt(parsed.format.size, 10);
      }
      if (isNaN(fileSize) || fileSize <= 0) {
        try {
          const stats = fs.statSync(filePath);
          fileSize = stats.size;
        } catch {
          fileSize = 0;
        }
      }

      resolve({
        format: "wav",
        codec: "pcm_s16le",
        sampleRate: 16000,
        channels: 1,
        bitDepth: bitDepth || 16,
        duration: Math.round(duration * 1000) / 1000, // round to 3 decimal places
        fileSize
      });
    });
  });
}

/**
 * Checks whether a media file contains at least one audio stream.
 */
export async function hasAudioStream(filePath: string): Promise<boolean> {
  const binary = getFFprobePath();

  const isAvailable = await checkFFprobeAvailable();
  if (!isAvailable) {
    throw new Error(
      `FFprobe executable not found or not runnable (tried: ${binary}). ` +
        `Please ensure FFprobe is installed or set FFPROBE_PATH in your environment.`
    );
  }

  const args = [
    "-v",
    "error",
    "-show_streams",
    "-print_format",
    "json",
    filePath
  ];

  return new Promise<boolean>((resolve, reject) => {
    const proc = spawn(binary, args, { shell: false });
    let stdoutData = "";
    let stderrData = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn FFprobe process: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `FFprobe exited with code ${code}. ${stderrData.trim() || "Invalid or corrupt media file."}`
          )
        );
      }

      try {
        const parsed = JSON.parse(stdoutData) as FFprobeOutput;
        const streams = parsed.streams || [];
        const audioStream = streams.find((s) => s.codec_type === "audio");
        resolve(Boolean(audioStream));
      } catch (parseErr) {
        reject(
          new Error(`Failed to parse FFprobe JSON output: ${parseErr instanceof Error ? parseErr.message : "Unknown error"}`)
        );
      }
    });
  });
}


