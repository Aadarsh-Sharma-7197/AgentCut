import { ObjectId } from "mongodb";
import type { Project } from "@agentcut/shared";

export interface ProjectDocument {
  _id: ObjectId;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toProjectDTO(doc: ProjectDocument): Project {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
}

