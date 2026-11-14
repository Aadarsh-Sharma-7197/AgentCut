import React, { useState } from "react";
import type { Project } from "@agentcut/shared";

interface DeleteConfirmModalProps {
  project: Project | null;
  onClose: () => void;
  onConfirm: (id: string) => Promise<void>;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  project,
  onClose,
  onConfirm
}) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;

  const handleConfirm = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await onConfirm(project.id);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete project.";
      setError(msg);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Delete Project</h2>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: "1rem", color: "var(--text-primary)" }}>
            Are you sure you want to delete <strong>&ldquo;{project.name}&rdquo;</strong>?
          </p>
          <div
            style={{
              padding: "0.85rem",
              backgroundColor: "rgba(239, 68, 68, 0.08)",
              border: "1px solid rgba(239, 68, 68, 0.2)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.85rem",
              color: "#fca5a5",
              lineHeight: 1.4
            }}
          >
            <strong>Note:</strong> Deletion removes only the project metadata. Original media files and disk contents are never modified or deleted.
          </div>
          {error && <div className="form-error" style={{ marginTop: "0.75rem" }}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : "Delete Project"}
          </button>
        </div>
      </div>
    </div>
  );
};

