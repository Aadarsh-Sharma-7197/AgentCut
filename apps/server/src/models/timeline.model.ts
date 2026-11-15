import { ObjectId } from "mongodb";
import type { Timeline, Track, TimelineSettings } from "@agentcut/shared";

export interface TimelineDocument {
  _id: ObjectId;
  timelineId: string;
  projectId: string;
  tracks: Track[];
  settings: TimelineSettings;
  createdAt: Date;
  updatedAt: Date;
}

export function toTimelineDTO(doc: TimelineDocument): Timeline {
  return {
    id: doc.timelineId,
    projectId: doc.projectId,
    tracks: doc.tracks,
    settings: doc.settings,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}

