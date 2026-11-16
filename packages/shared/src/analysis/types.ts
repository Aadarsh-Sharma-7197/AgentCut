export type AudioExtractionStatus = "queued" | "extracting" | "completed" | "failed" | "no_audio";

export interface AudioProperties {
  format: string; // "wav"
  codec: string; // "pcm_s16le"
  sampleRate: number; // 16000
  channels: number; // 1
  bitDepth: number; // 16
  duration: number; // duration in seconds
}

export interface AudioExtractionArtifact {
  id: string;
  projectId: string;
  assetId: string;
  status: AudioExtractionStatus;
  audioProperties?: AudioProperties;
  artifactSize?: number;
  completedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export type SilenceDetectionStatus = "detecting" | "completed" | "failed";

export interface SilenceInterval {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceDetectionParameters {
  noiseThresholdDb: number;
  minDurationSeconds: number;
}

export interface SilenceDetectionArtifact {
  id: string;
  projectId: string;
  assetId: string;
  status: SilenceDetectionStatus;
  parameters: SilenceDetectionParameters;
  intervals: SilenceInterval[];
  totalSilenceDuration: number;
  audioDuration: number;
  completedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

