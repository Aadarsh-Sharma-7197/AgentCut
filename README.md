# AgentCut

AgentCut is an AI-native video editing agent operating on a real, editable, non-destructive timeline.

## Workspace Architecture

This repository is structured as a Turborepo monorepo with npm workspaces:

```
AgentCut/
├── apps/
│   ├── server/       # Node.js + Express + TypeScript backend API
│   └── web/          # React + Vite + TypeScript frontend web app
├── packages/
│   └── shared/       # Shared TypeScript types, schemas, and utilities
├── project_context.md# Project context and architectural source of truth
├── turbo.json        # Turborepo task pipeline configuration
└── package.json      # Root npm workspaces configuration
```

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+ recommended, v22+ tested)
- [npm](https://www.npmjs.com/) (v10+ recommended)

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Build all workspaces:**
   ```bash
   npm run build
   ```

3. **Run typechecking across all workspaces:**
   ```bash
   npm run typecheck
   ```

4. **Start development mode:**
   ```bash
   npm run dev
   ```

## Development Roadmap

Refer to [project_context.md](./project_context.md) for full project principles, constraints, and the roadmap. Current status: **Phase 0 Foundation**.

