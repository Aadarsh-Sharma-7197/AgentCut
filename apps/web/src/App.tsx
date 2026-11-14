import { useState, useEffect, useCallback } from "react";
import type { Project } from "@agentcut/shared";
import {
  fetchProjects,
  fetchProjectById,
  createProjectApi,
  deleteProjectApi
} from "./api/projects";
import { Header } from "./components/Header";
import { Dashboard } from "./components/Dashboard";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { CreateProjectModal } from "./components/CreateProjectModal";
import { DeleteConfirmModal } from "./components/DeleteConfirmModal";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchProjects();
      setProjects(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load projects.";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleOpenProject = async (id: string) => {
    try {
      setIsLoading(true);
      const project = await fetchProjectById(id);
      setSelectedProject(project);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to open project.";
      alert(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateProject = async (name: string) => {
    await createProjectApi(name);
    await loadProjects();
  };

  const handleDeleteProject = async (id: string) => {
    await deleteProjectApi(id);
    if (selectedProject?.id === id) {
      setSelectedProject(null);
    }
    await loadProjects();
  };

  return (
    <div className="app-container">
      <Header onHomeClick={() => setSelectedProject(null)} />

      <main className="main-content">
        {selectedProject ? (
          <ProjectWorkspace
            project={selectedProject}
            onBack={() => setSelectedProject(null)}
          />
        ) : (
          <Dashboard
            projects={projects}
            isLoading={isLoading}
            error={error}
            onRetry={loadProjects}
            onNewProject={() => setIsCreateModalOpen(true)}
            onOpenProject={handleOpenProject}
            onDeleteProject={(proj) => setProjectToDelete(proj)}
          />
        )}
      </main>

      <CreateProjectModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateProject}
      />

      <DeleteConfirmModal
        project={projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirm={handleDeleteProject}
      />
    </div>
  );
}

export default App;
