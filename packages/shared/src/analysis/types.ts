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

