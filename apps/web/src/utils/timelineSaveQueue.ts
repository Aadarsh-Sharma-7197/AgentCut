import type { Timeline } from "@agentcut/shared";

export interface TimelineSaveQueueOptions {
  saveFn: (timeline: Timeline) => Promise<Timeline>;
  onSaveStart?: () => void;
  onSaveSuccess?: (savedTimeline: Timeline) => void;
  onSaveError?: (error: Error, rolledBackTimeline: Timeline | null) => void;
  initialTimeline?: Timeline | null;
}

/**
 * Serializes timeline persistence requests to guarantee that:
 * 1. At most one HTTP PUT request is in flight at any given time.
 * 2. Older requests can never arrive at MongoDB after newer requests.
 * 3. Rapid successive edits coalesce into a single trailing save of the freshest state.
 * 4. A failed earlier save does not incorrectly roll back a newer successful edit.
 * 5. If the final pending save fails, the state safely rolls back to the last confirmed server state.
 */
export class TimelineSaveQueue {
  private saveFn: (timeline: Timeline) => Promise<Timeline>;
  private inFlight = false;
  private pendingTimeline: Timeline | null = null;
  private lastSavedTimeline: Timeline | null = null;
  private onSaveStart?: () => void;
  private onSaveSuccess?: (savedTimeline: Timeline) => void;
  private onSaveError?: (error: Error, rolledBackTimeline: Timeline | null) => void;

  constructor(options: TimelineSaveQueueOptions) {
    this.saveFn = options.saveFn;
    this.lastSavedTimeline = options.initialTimeline ?? null;
    this.onSaveStart = options.onSaveStart;
    this.onSaveSuccess = options.onSaveSuccess;
    this.onSaveError = options.onSaveError;
  }

  public setLastSavedTimeline(timeline: Timeline | null): void {
    this.lastSavedTimeline = timeline;
  }

  public getLastSavedTimeline(): Timeline | null {
    return this.lastSavedTimeline;
  }

  public isBusy(): boolean {
    return this.inFlight || this.pendingTimeline !== null;
  }

  public getPendingTimeline(): Timeline | null {
    return this.pendingTimeline;
  }

  /**
   * Waits for all in-flight and pending save operations to settle.
   */
  public async waitForIdle(): Promise<void> {
    while (this.isBusy()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Alias for waitForIdle().
   */
  public async drain(): Promise<void> {
    return this.waitForIdle();
  }

  /**
   * Enqueues a timeline state for persistence.
   * If a save is already running, the pending payload is updated to the latest state.
   */
  public enqueue(timeline: Timeline): void {
    if (this.inFlight) {
      // Coalesce: always retain the freshest timeline payload as the next in line
      this.pendingTimeline = timeline;
      return;
    }

    void this.processQueue(timeline);
  }

  private async processQueue(timelineToSave: Timeline): Promise<void> {
    this.inFlight = true;
    let currentPayload: Timeline | null = timelineToSave;

    while (currentPayload) {
      this.onSaveStart?.();
      try {
        const saved = await this.saveFn(currentPayload);
        this.lastSavedTimeline = saved;

        if (this.pendingTimeline) {
          // A newer edit occurred while this save was in flight; process it next
          currentPayload = this.pendingTimeline;
          this.pendingTimeline = null;
        } else {
          // Queue is empty; all edits persisted
          currentPayload = null;
          this.onSaveSuccess?.(saved);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.pendingTimeline) {
          // A newer edit is waiting. Proceed directly to persist the newer edit
          // rather than rolling back to an obsolete intermediate state
          currentPayload = this.pendingTimeline;
          this.pendingTimeline = null;
        } else {
          // No newer edit exists and persistence failed: trigger rollback to last known durable state
          currentPayload = null;
          this.onSaveError?.(error, this.lastSavedTimeline);
        }
      }
    }

    this.inFlight = false;
  }
}

