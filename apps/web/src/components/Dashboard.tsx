import React from "react";
import type { Project } from "@agentcut/shared";
import { ProjectCard } from "./ProjectCard";

interface DashboardProps {
  projects: Project[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onNewProject: () => void;
  onOpenProject: (id: string) => void;
  onDeleteProject: (project: Project) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  projects,
  isLoading,
  error,
  onRetry,
  onNewProject,
  onOpenProject,
  onDeleteProject
}) => {
  return (
    <div>
      <div className="action-bar">
        <div>
          <h2 className="section-title">Projects</h2>
          <p className="section-subtitle">
            Manage your video projects and editing sessions
          </p>
        </div>
        <button className="btn btn-primary" onClick={onNewProject}>
          + New Project
        </button>
      </div>

      {error && (
        <div className="error-banner">
          <div className="error-content">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
          <button className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading projects...</p>
        </div>
      ) : projects.length === 0 && !error ? (
        <div className="empty-state">
          <div className="empty-icon">📁</div>
          <h3 className="empty-title">No projects yet</h3>
          <p className="empty-desc">
            Create your first project to start organizing footage and editing with the agent.
          </p>
          <button className="btn btn-primary" onClick={onNewProject}>
            Create Project
          </button>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={onOpenProject}
              onDelete={onDeleteProject}
            />
          ))}
        </div>
      )}
    </div>
  );
};

