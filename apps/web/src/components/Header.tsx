import React from "react";
import { AGENTCUT_VERSION } from "@agentcut/shared";

interface HeaderProps {
  onHomeClick: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onHomeClick }) => {
  return (
    <header className="app-header">
      <div className="header-content">
        <div className="brand-wrapper" onClick={onHomeClick}>
          <div className="brand-icon">AC</div>
          <div>
            <span className="brand-title">AgentCut</span>
          </div>
          <span className="brand-badge">v{AGENTCUT_VERSION}</span>
        </div>
      </div>
    </header>
  );
};

