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

// -------------------------------------------------------------
// Step 5.5: Unified Media Intelligence Foundation Types
// -------------------------------------------------------------

export type AnalysisModalityStatus =
  | "not_started"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "canceled"
  | "no_stream"
  | "not_applicable";

export type UnifiedIntelligenceStatus =
  | "completed"
  | "partial"
  | "processing"
  | "empty"
  | "canceled"
  | "failed";

export interface ModalityAudioSummary {
  status: AnalysisModalityStatus;
  hasArtifact?: boolean;
  error?: string;
}

export interface ModalitySilenceSummary {
  status: AnalysisModalityStatus;
  intervalCount?: number;
  totalSilenceDuration?: number;
  error?: string;
}

export interface ModalityTranscriptionSummary {
  status: AnalysisModalityStatus;
  wordCount?: number;
  segmentCount?: number;
  speechDuration?: number;
  detectedLanguage?: string;
  hasArtifact?: boolean;
  error?: string;
}

export interface ModalityScenesSummary {
  status: AnalysisModalityStatus;
  sceneCount?: number;
  analysisId?: string;
  error?: string;
}

export interface IntelligenceAggregatedDurations {
  totalDuration: number;
  speechDuration: number;
  silenceDuration: number;
  speechCoverageRatio: number;
  silenceCoverageRatio: number;
}

export interface UnifiedMediaIntelligenceManifest {
  projectId: string;
  assetId: string;
  duration: number;
  hasAudio: boolean | null; // null represents unconfirmed / unknown stream availability
  videoCodec: string;
  audioCodec: string | null;
  resolution: {
    width: number;
    height: number;
  };
  fps: number;
  overallStatus: UnifiedIntelligenceStatus;
  modalities: {
    audio: ModalityAudioSummary;
    silence: ModalitySilenceSummary;
    transcription: ModalityTranscriptionSummary;
    scenes: ModalityScenesSummary;
  };
  aggregated: IntelligenceAggregatedDurations;
}

export interface TimelineQueryOptions {
  start?: number;
  end?: number;
  include?: string;
}

export interface TimelineSliceScene {
  sceneId: string;
  index: number;
  frameUrl: string | null;
}

export interface TimelineSliceSpeechWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface UnifiedTimelineSlice {
  start: number;
  end: number;
  duration: number;
  scene?: TimelineSliceScene;
  speechWords?: TimelineSliceSpeechWord[];
  isSilence?: boolean;
}

export interface UnifiedTimelineResponse {
  window: {
    start: number;
    end: number;
    duration: number;
  };
  totalSlices: number;
  slices: UnifiedTimelineSlice[];
}

// -------------------------------------------------------------
// Step 5.6: Searchable Media Intelligence Types
// -------------------------------------------------------------

export interface SpeechSearchWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface SpeechSearchMatch {
  id: string;
  type: "speech";
  assetId: string;
  assetName: string;
  start: number;
  end: number;
  matchedText: string;
  segmentIds: number[];
  segmentText: string;
  words: SpeechSearchWord[];
}

export interface SpeechSearchResponse {
  query: string;
  assetId: string;
  assetName: string;
  totalMatches: number;
  limit: number;
  offset: number;
  matches: SpeechSearchMatch[];
}

export interface SilenceSearchMatch {
  id: string;
  type: "silence";
  assetId: string;
  start: number;
  end: number;
  duration: number;
}

export interface SilenceSearchResponse {
  assetId: string;
  totalMatches: number;
  limit: number;
  offset: number;
  matches: SilenceSearchMatch[];
}

export interface SceneSearchMatch {
  id: string;
  type: "scene";
  assetId: string;
  sceneIndex: number;
  start: number;
  end: number;
  duration: number;
  transitionType?: string;
  frameUrl: string | null;
}

export interface SceneSearchResponse {
  assetId: string;
  totalMatches: number;
  limit: number;
  offset: number;
  matches: SceneSearchMatch[];
}

export interface UnifiedSpeechSceneContext {
  sceneId: string;
  index: number;
  start: number;
  end: number;
  frameUrl: string | null;
}

export interface UnifiedAssetSearchMatch extends SpeechSearchMatch {
  scene: UnifiedSpeechSceneContext | null;
}

export interface UnifiedAssetSearchResponse {
  query: string;
  assetId: string;
  assetName: string;
  sceneContextAvailable: boolean;
  totalMatches: number;
  limit: number;
  offset: number;
  matches: UnifiedAssetSearchMatch[];
}

export interface UnsearchableAssetInfo {
  assetId: string;
  assetName: string;
  reason: string;
}

export interface ProjectIntelligenceSearchResponse {
  query: string;
  projectId: string;
  searchedAssetCount: number;
  unsearchableAssetCount: number;
  searchComplete: boolean;
  unsearchableAssets: UnsearchableAssetInfo[];
  totalMatches: number;
  limit: number;
  offset: number;
  matches: SpeechSearchMatch[];
}

