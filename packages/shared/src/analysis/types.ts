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

export type SceneDetectionStatus = "detecting" | "completed" | "failed" | "canceled";

export interface Scene {
  id: string; // e.g. `${analysisId}_s${index}`
  index: number;
  start: number; // in seconds, rounded to 3 decimal places
  end: number; // in seconds, rounded to 3 decimal places
  duration: number; // end - start, in seconds
  representativeTimestamp: number; // midpoint timestamp in seconds
  score?: number; // FFmpeg scene change score if available
  frameAvailable: boolean;
  frameUrl?: string; // relative API endpoint: /api/projects/:projectId/media/:assetId/scenes/analyses/:analysisId/frames/:sceneId
}

export interface SceneDetectionParameters {
  threshold: number; // between 0.05 and 1.0 (default: 0.3)
  minSceneDuration: number; // between 0.1 and 3600.0 (default: 0.5)
  maxScenes: number; // between 1 and 2000 (default: 500)
}

export interface SceneDetectionArtifact {
  id: string;
  projectId: string;
  assetId: string;
  status: SceneDetectionStatus;
  parameters: SceneDetectionParameters;
  scenes: Scene[];
  sceneCount: number;
  videoDuration: number;
  completedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

