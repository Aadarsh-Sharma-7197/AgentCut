import { ObjectId } from "mongodb";
import type { Timeline, Track, TimelineSettings } from "@agentcut/shared";

export interface TimelineDocument {
  _id: ObjectId;
  timelineId: string;
  projectId: string;
  tracks: Track[];
  settings: TimelineSettings;
  revision?: number;
  lastExecutionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toTimelineDTO(doc: TimelineDocument): Timeline {
  return {
    id: doc.timelineId,
    projectId: doc.projectId,
    tracks: doc.tracks,
    settings: doc.settings,
    revision: typeof doc.revision === "number" && Number.isInteger(doc.revision) && doc.revision >= 1 ? doc.revision : 1,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}

