import {
  normalizeAll,
  type InventorySnapshot,
  type SandboxLiveView,
  type TimelineEvent,
} from "@agent-sandbox/dashboard-shared";

interface SandboxKey {
  namespace: string;
  name: string;
}

interface RememberedState {
  runtimeState: SandboxLiveView["runtimeState"];
  objectState: SandboxLiveView["objectState"];
  effectiveReady: boolean;
}

export interface SnapshotDiffEventSourceOptions {
  /** When deriving transitions, override Date.now() (tests). */
  now?: () => number;
}

/** Stateful event source that emits TimelineEvents when a sandbox transitions
 *  between snapshots. Subscribe via {@link consume}. */
export class SnapshotDiffEventSource {
  private readonly previous = new Map<string, RememberedState>();
  private readonly now: () => number;

  constructor(options: SnapshotDiffEventSourceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  consume(snapshot: InventorySnapshot): Map<string, TimelineEvent[]> {
    const eventsBySandbox = new Map<string, TimelineEvent[]>();
    const inventory = normalizeAll(snapshot, new Date(this.now()));
    for (const sandbox of inventory.sandboxes) {
      const key = `${sandbox.namespace}/${sandbox.name}`;
      const previous = this.previous.get(key);
      const events: TimelineEvent[] = [];

      if (previous) {
        if (previous.runtimeState !== sandbox.runtimeState) {
          events.push(this.makeEvent(sandbox, `runtime:${previous.runtimeState}->${sandbox.runtimeState}`, sandbox.runtimeState));
        }
        if (previous.objectState !== sandbox.objectState) {
          events.push(this.makeEvent(sandbox, `object:${previous.objectState}->${sandbox.objectState}`, sandbox.objectState));
        }
        if (previous.effectiveReady !== sandbox.effectiveReady) {
          events.push(
            this.makeEvent(
              sandbox,
              sandbox.effectiveReady ? "Ready=True" : "Ready=False",
              sandbox.effectiveReady ? "Sandbox became ready" : "Sandbox lost readiness",
            ),
          );
        }
      }

      this.previous.set(key, {
        runtimeState: sandbox.runtimeState,
        objectState: sandbox.objectState,
        effectiveReady: sandbox.effectiveReady,
      });

      if (events.length > 0) eventsBySandbox.set(key, events);
    }

    // Forget sandboxes that disappeared so they don't accumulate memory.
    const seenKeys = new Set(inventory.sandboxes.map((s) => `${s.namespace}/${s.name}`));
    for (const key of this.previous.keys()) {
      if (!seenKeys.has(key)) this.previous.delete(key);
    }

    return eventsBySandbox;
  }

  private makeEvent(target: SandboxKey, reason: string, message: string): TimelineEvent {
    const at = new Date(this.now()).toISOString();
    return {
      id: `diff:${target.namespace}/${target.name}:${reason}:${at}`,
      kind: "transition",
      at,
      resourceKind: "Sandbox",
      resourceName: target.name,
      namespace: target.namespace,
      reason,
      message,
      severity: "info",
    };
  }
}
