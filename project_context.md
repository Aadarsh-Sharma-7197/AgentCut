# AgentCut — Project Context

> This document is the source of truth for the AgentCut project. Read it before making architectural or implementation changes. Update it when a decision is explicitly approved.

## 1. Product vision

AgentCut is an **AI-native video editing agent**. Users describe editing goals in natural language; the agent analyzes footage, plans edits, executes controlled editing tools, and updates a real, editable, non-destructive timeline.

The editor is the environment in which the agent operates. The agent—not a chatbot—is the product's primary differentiator.

### Product principles
- **Real edits, not a black box:** AI changes must be represented on an editable timeline.
- **Non-destructive:** original media is never modified; edits reference source media.
- **Agentic but controlled:** the agent plans and executes multi-step workflows using allowlisted tools.
- **Human control:** users can inspect changes, intervene, undo, and approve consequential actions.
- **Local-first and ₹0 development:** prioritize open-source software and local inference; optional cloud APIs must not be mandatory for core functionality.
- **Incremental engineering:** build, test, and understand one vertical slice at a time.
- **Honest capability claims:** no claims of real-time or unlimited processing without measurements.

## 2. Initial MVP (scope)

Build a local application that can:
1. Create and open a project.
2. Import one video file and inspect its metadata.
3. Preview the source video.
4. Represent video/audio/caption tracks and clips in a timeline.
5. Split, trim, move, and delete clips.
6. Save and reload timeline state.
7. Undo and redo editing operations.
8. Render the timeline to MP4 through FFmpeg.
9. Later, accept natural-language instructions and apply validated edits through an agent.

### Not in initial scope
- A full Premiere Pro/DaVinci Resolve replacement.
- Training custom foundation models.
- Distributed rendering across multiple machines.
- Mandatory paid APIs or paid cloud storage.
- Unrestricted LLM shell/filesystem access.
- Multi-agent orchestration before a single-agent workflow works.
- Advanced generative video/B-roll as a prerequisite.

## 3. Working technology direction

These are the current proposed choices, not permission to install everything immediately. Confirm compatibility and add dependencies only when a feature needs them.

### Frontend
- React
- TypeScript
- Vite
- Tailwind CSS
- Browser video playback for source preview
- A custom timeline UI/engine initially

### Backend
- Node.js
- Express
- TypeScript
- REST APIs initially
- WebSockets or Server-Sent Events for job progress when needed

### Data and media
- MongoDB for project/timeline metadata (initially local)
- Local filesystem for media, proxies, thumbnails, and exports
- Keep media binaries out of MongoDB documents

### Processing and AI (incremental)
- FFmpeg and FFprobe for media inspection/rendering
- Whisper-compatible local transcription, when transcription is introduced
- Ollama/local LLM for local planning, subject to hardware/model evaluation
- Optional vision APIs or local vision models; never assume free-tier availability is permanent
- Redis + BullMQ only when background-job requirements justify introducing them

## 4. Core architecture

Conceptual flow:

User instruction
→ Agent orchestration / planning
→ Retrieval and media context
→ Structured edit plan
→ Validation and permission checks
→ Timeline operation tools
→ Timeline/project state
→ Preview and render pipeline
→ Result/evaluation and user feedback

### Responsibility boundaries
- **LLM:** interpret intent and propose structured plans; it does not directly mutate database state or execute arbitrary commands.
- **Agent runtime:** manages steps, tool calls, limits, retries, checkpoints, and approvals.
- **Tool layer:** exposes narrow, typed, allowlisted actions (e.g. search transcript, split clip, trim clip, add caption, request render).
- **Timeline engine:** validates and applies editing operations deterministically.
- **FFmpeg:** performs media processing/rendering; it is not the timeline's source of truth.
- **Database:** persists project metadata, timeline state, operation history, and job metadata.
- **Worker:** performs long-running media tasks outside HTTP request handlers.

## 5. Timeline principles

Use a non-destructive timeline model.

A clip should distinguish:
- `assetId`: reference to original media.
- `sourceStart`: start time within original media.
- `sourceEnd`: end time within original media.
- `timelineStart`: placement on the edited timeline.
- `trackId`: track containing the clip.
- Stable clip and track IDs.

Derived clip duration is `sourceEnd - sourceStart`. Do not store contradictory duration values unless there is a clear reason.

Timeline operations should be typed, validated, deterministic, and reversible where practical. Use an operation history/checkpoint strategy for undo/redo and agent-level rollback.

Do not let an LLM emit arbitrary FFmpeg command strings. The application should translate validated timeline state into a render plan.

## 6. Agent behavior and safety

The intended interaction model is a **hybrid editing agent**:
- Routine, reversible edits may execute autonomously.
- Large or destructive-looking changes should be previewed or require confirmation.
- Every agent action should be visible and explainable in a concise activity log.
- Users can undo agent changes.
- Tool inputs and outputs must be schema-validated.
- Set iteration, tool-call, time, and media-size limits.
- Handle failures explicitly; never claim an edit/render succeeded without confirmation.
- No unrestricted shell, arbitrary filesystem access, or arbitrary command execution from model output.
- Keep secrets in environment variables; never commit `.env` or credentials.

## 7. Development workflow

For every feature:
1. Explain the problem and design.
2. Agree on acceptance criteria.
3. Make a small implementation plan.
4. Implement a focused change.
5. Run relevant checks/tests.
6. Review the diff and explain important code.
7. Update this document if an approved decision changes.

Antigravity is the coding assistant. The project owner must understand and verify generated code. Do not ask Antigravity to build the entire application in one prompt.

### Coding-agent instructions
- Read this file before coding.
- Inspect the existing repository before proposing changes.
- Do not overwrite or reorganize existing work without asking.
- Do not add dependencies, services, or architectural patterns without explaining why.
- Keep changes scoped to the current task.
- Prefer simple, maintainable code over speculative abstractions.
- Report files changed, commands run, test results, and unresolved issues.
- Never fabricate test results.
- Ask before changing a decision marked as approved.

## 8. Repository conventions (to establish during setup)

- Use clear, feature-oriented modules.
- Keep frontend and backend boundaries explicit.
- Validate API inputs.
- Use consistent error responses and logging.
- Avoid committing media files, generated exports, model weights, `node_modules`, secrets, or local databases.
- Add `.gitignore` before installing/building substantial tooling.
- Add README setup instructions as the project becomes runnable.
- Use Git commits after verified milestones.

## 9. Roadmap

### Phase 0 — Foundation
- Repository hygiene and `.gitignore`
- Project specification and architecture decisions
- Frontend/backend workspace structure
- Development scripts and health check

### Phase 1 — Media foundation
- Project creation
- Media import
- Metadata extraction with FFprobe
- Local media storage
- Source preview and thumbnails

### Phase 2 — Timeline MVP
- Timeline data model
- Tracks and clips
- Playhead and preview
- Split/trim/move/delete
- Save/load
- Undo/redo
- Basic render/export

### Phase 3 — Media intelligence
- Audio extraction
- Transcription and timestamps
- Silence detection
- Scene/frame sampling
- Searchable media index

### Phase 4 — Agent MVP
- Structured edit-plan schema
- LLM planning
- Tool calling
- Validation
- Agent operation log
- Approval and rollback
- Natural-language editing workflows

### Phase 5 — Advanced agent
- Semantic retrieval/RAG where justified
- Visual understanding
- Highlight selection
- Captions and audio enhancement
- B-roll suggestions/insertion
- Shorts generation
- Evaluation and performance work

## 10. Success criteria

The first meaningful milestone is not “AI works.” It is:

**A user imports a video, edits clips on a timeline, saves the project, and renders a correct MP4 without modifying the original media.**

The first agent milestone is:

**A user gives one natural-language edit request; the agent produces a validated plan, applies it to the timeline, explains its changes, and supports undo.**

## 11. Decision log

Record decisions here with date, decision, rationale, and alternatives considered.

- **2026-11-14 — Product direction:** AgentCut is an AI editing agent operating on a real, editable timeline; it is not just a video editor with a chatbot.
- **2026-11-14 — Cost constraint:** target ₹0 for development and local MVP; optional external APIs may have changing limits.
- **2026-11-14 — Agent model:** start with one orchestrated agent and tools; do not introduce multi-agent architecture prematurely.
- **2026-11-14 — Interaction model:** hybrid autonomy with user control, visibility, and undo.
- **2026-11-14 — Build strategy:** incremental, tested vertical slices; do not generate the entire application at once.

---
*Update this document only when a decision is confirmed or implementation details become known.*
