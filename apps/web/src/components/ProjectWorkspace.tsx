import React from "react";
import type { Project } from "@agentcut/shared";

interface ProjectWorkspaceProps {
  project: Project;
  onBack: () => void;
}

export const ProjectWorkspace: React.FC<ProjectWorkspaceProps> = ({
  project,
  onBack
}) => {
  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString();
    } catch {
      return isoString;
    }
  };

  return (
    <div className="workspace-container">
      <button className="back-btn" onClick={onBack}>
        ← Back to Projects
      </button>

      <div className="workspace-header">
        <div className="workspace-title-row">
          <div>
            <h1 className="workspace-title">{project.name}</h1>
            <p className="section-subtitle">Project Workspace</p>
          </div>
        </div>
      </div>

      <div className="info-cards-grid">
        <div className="info-card">
          <div className="info-label">Project ID</div>
          <div className="info-value">{project.id}</div>
        </div>
        <div className="info-card">
          <div className="info-label">Last Updated</div>
          <div className="info-value">{formatDate(project.updatedAt)}</div>
        </div>
        <div className="info-card">
          <div className="info-label">Created At</div>
          <div className="info-value">{formatDate(project.createdAt)}</div>
        </div>
      </div>

      <div className="placeholder-notice">
        <h3>Project Workspace Placeholder</h3>
        <p>
          This is the workspace container for <strong>{project.name}</strong>.
          In Phase 1 Step 2 and Phase 2, the media asset inspector and non-destructive timeline editor will be mounted here.
        </p>
      </div>
    </div>
  );
};

