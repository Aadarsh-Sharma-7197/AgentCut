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

export type TranscriptionStatus = "queued" | "processing" | "completed" | "failed" | "canceled";
export type TranscriptionDevice = "cuda" | "cpu";

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface TranscriptData {
  language: string;
  languageProbability?: number;
  duration: number;
  segments: TranscriptSegment[];
  text: string;
}

export interface TranscriptionParameters {
  modelName: "small" | "base";
  languageHint?: string;
  device?: "auto" | "cuda" | "cpu";
  computeType?: string;
}

export interface TranscriptionArtifact {
  id: string;
  projectId: string;
  assetId: string;
  status: TranscriptionStatus;
  parameters: TranscriptionParameters;
  detectedLanguage?: string;
  languageProbability?: number;
  audioDuration?: number;
  segmentCount?: number;
  executionDevice?: TranscriptionDevice;
  computeType?: string;
  engineMetadata?: {
    engine: string;
    version?: string;
  };
  error?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptionWithTranscript extends TranscriptionArtifact {
  transcript?: TranscriptData;
}

