import type { Timeline } from "./types.js";
import { validateTimeline, TimelineValidationError } from "./validation.js";

export const DEFAULT_MAX_HISTORY = 50;

export interface TimelineHistoryOptions {
  maxHistory?: number;
  initialTimeline?: Timeline;
  validate?: boolean;
}

/**
 * Creates a deep copy of a timeline to ensure snapshot immutability.
 */
export function cloneTimeline(timeline: Timeline): Timeline {
  return {
    ...timeline,
    settings: { ...timeline.settings },
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({ ...clip }))
    }))
  };
}

/**
 * Checks whether two timeline states are structurally and functionally equivalent
 * to avoid recording redundant identical history states.
 */
export function areTimelinesEquivalent(a: Timeline, b: Timeline): boolean {
  if (a === b) return true;
  if (
    a.settings.frameRate !== b.settings.frameRate ||
    a.settings.width !== b.settings.width ||
    a.settings.height !== b.settings.height
  ) {
    return false;
  }
  if (a.tracks.length !== b.tracks.length) return false;

  for (let i = 0; i < a.tracks.length; i++) {
    const tA = a.tracks[i];
    const tB = b.tracks[i];
    if (
      tA.id !== tB.id ||
      tA.name !== tB.name ||
      tA.index !== tB.index ||
      tA.type !== tB.type ||
      tA.enabled !== tB.enabled ||
      tA.clips.length !== tB.clips.length
    ) {
      return false;
    }
    for (let j = 0; j < tA.clips.length; j++) {
      const cA = tA.clips[j];
      const cB = tB.clips[j];
      if (
        cA.id !== cB.id ||
        cA.timelineStart !== cB.timelineStart ||
        cA.sourceStart !== cB.sourceStart ||
        cA.sourceEnd !== cB.sourceEnd ||
        cA.assetId !== cB.assetId ||
        cA.trackId !== cB.trackId ||
        cA.name !== cB.name
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Predictable, immutable Undo/Redo history stack for timeline editing.
 *
 * Guarantees:
 * - Immutable snapshots: returning or pushing timelines never shares mutable references.
 * - Validation: all stored snapshots pass timeline validation.
 * - Duplicate suppression: redundant identical edits are not pushed.
 * - Redo invalidation: performing a new edit after undoing removes abandoned redo branches.
 * - Bounded memory: history length is bounded by maxHistory using a sliding window.
 * - Reconcile on failure: safely reconciles history position if a server persistence fails.
 */
export class TimelineHistory {
  private snapshots: Timeline[] = [];
  private currentIndex: number = -1;
  private maxHistory: number;
  private validate: boolean;

  constructor(options?: TimelineHistoryOptions) {
    this.maxHistory = Math.max(2, options?.maxHistory ?? DEFAULT_MAX_HISTORY);
    this.validate = options?.validate ?? true;
    if (options?.initialTimeline) {
      this.init(options.initialTimeline);
    }
  }

  /**
   * Initializes the history stack with the initial confirmed timeline baseline.
   */
  public init(initialTimeline: Timeline): void {
    if (this.validate) {
      const validation = validateTimeline(initialTimeline);
      if (!validation.valid) {
        throw new TimelineValidationError(
          "Cannot initialize history: invalid timeline.",
          validation.errors
        );
      }
    }
    this.snapshots = [cloneTimeline(initialTimeline)];
    this.currentIndex = 0;
  }

  public getCurrent(): Timeline | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.snapshots.length) {
      return cloneTimeline(this.snapshots[this.currentIndex]);
    }
    return null;
  }

  public canUndo(): boolean {
    return this.currentIndex > 0;
  }

  public canRedo(): boolean {
    return this.currentIndex >= 0 && this.currentIndex < this.snapshots.length - 1;
  }

  public getUndoCount(): number {
    return Math.max(0, this.currentIndex);
  }

  public getRedoCount(): number {
    return Math.max(0, this.snapshots.length - 1 - this.currentIndex);
  }

  public getHistoryLength(): number {
    return this.snapshots.length;
  }

  public getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Records a new confirmed timeline edit state.
   * Discards any abandoned redo branch and enforces duplicate state suppression and max history limits.
   *
   * @param timeline The new timeline state to record.
   * @returns true if a new history entry was recorded, false if duplicate was suppressed.
   */
  public push(timeline: Timeline): boolean {
    if (this.validate) {
      const validation = validateTimeline(timeline);
      if (!validation.valid) {
        throw new TimelineValidationError(
          "Cannot push to history: invalid timeline.",
          validation.errors
        );
      }
    }

    // Uninitialized history
    if (this.currentIndex < 0 || this.snapshots.length === 0) {
      this.snapshots = [cloneTimeline(timeline)];
      this.currentIndex = 0;
      return true;
    }

    const current = this.snapshots[this.currentIndex];
    // Duplicate state suppression
    if (areTimelinesEquivalent(current, timeline)) {
      return false;
    }

    // Discard any abandoned redo branch
    this.snapshots = this.snapshots.slice(0, this.currentIndex + 1);

    // Push deep copy snapshot
    this.snapshots.push(cloneTimeline(timeline));
    this.currentIndex++;

    // Enforce history limit (sliding window drops oldest)
    if (this.snapshots.length > this.maxHistory) {
      const overflow = this.snapshots.length - this.maxHistory;
      this.snapshots = this.snapshots.slice(overflow);
      this.currentIndex = Math.max(0, this.currentIndex - overflow);
    }

    return true;
  }

  /**
   * Undoes the last edit and returns the previous timeline state.
   * Returns null if no earlier state exists.
   */
  public undo(): Timeline | null {
    if (!this.canUndo()) {
      return null;
    }
    this.currentIndex--;
    return cloneTimeline(this.snapshots[this.currentIndex]);
  }

  /**
   * Redoes the previously undone edit and returns the next timeline state.
   * Returns null if no later state exists.
   */
  public redo(): Timeline | null {
    if (!this.canRedo()) {
      return null;
    }
    this.currentIndex++;
    return cloneTimeline(this.snapshots[this.currentIndex]);
  }

  /**
   * Reconciles history with a known server state if persistence fails.
   * If rolling back from an unconfirmed forward edit (currentIndex > i),
   * unconfirmed forward snapshots are truncated to avoid leaving invalid redo branches.
   */
  public reconcile(persistedTimeline: Timeline): void {
    for (let i = 0; i < this.snapshots.length; i++) {
      if (areTimelinesEquivalent(this.snapshots[i], persistedTimeline)) {
        if (this.currentIndex > i) {
          this.snapshots = this.snapshots.slice(0, i + 1);
        }
        this.currentIndex = i;
        return;
      }
    }
    // If not found in current snapshots, re-initialize to persisted state
    this.init(persistedTimeline);
  }
}

