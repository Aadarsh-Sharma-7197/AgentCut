import React from "react";
import type { Project } from "@agentcut/shared";

interface ProjectCardProps {
  project: Project;
  onOpen: (id: string) => void;
  onDelete: (project: Project) => void;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  onOpen,
  onDelete
}) => {
  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="project-card">
      <div className="card-header">
        <h3 className="project-name" title={project.name}>
          {project.name}
        </h3>
        <div className="project-dates">
          <span>Updated: {formatDate(project.updatedAt)}</span>
          <span>Created: {formatDate(project.createdAt)}</span>
        </div>
      </div>
      <div className="card-actions">
        <button
          className="btn btn-primary"
          onClick={() => onOpen(project.id)}
        >
          Open
        </button>
        <button
          className="btn btn-danger"
          onClick={() => onDelete(project)}
        >
          Delete
        </button>
      </div>
    </div>
  );
};

