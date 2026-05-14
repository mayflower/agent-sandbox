import { dedupeEvents, type TimelineEvent } from "@agent-sandbox/dashboard-shared";

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SandboxKey {
  namespace: string;
  name: string;
}

function keyOf(target: SandboxKey): string {
  return `${target.namespace}/${target.name}`;
}

export interface TimelineStoreOptions {
  maxEventsPerSandbox?: number;
  maxAgeMs?: number;
  /** Allows tests to inject deterministic time. */
  now?: () => number;
}

/** Per-sandbox ring buffer of timeline events. The same event id arriving
 *  multiple times is deduped. */
export class TimelineStore {
  private readonly events = new Map<string, TimelineEvent[]>();
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: TimelineStoreOptions = {}) {
    this.maxEvents = options.maxEventsPerSandbox ?? DEFAULT_MAX_EVENTS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  ingest(target: SandboxKey, events: TimelineEvent[]): void {
    if (events.length === 0) return;
    const key = keyOf(target);
    const existing = this.events.get(key) ?? [];
    const merged = dedupeEvents([...existing, ...events]).sort(
      (left, right) => Date.parse(left.at) - Date.parse(right.at),
    );

    const cutoff = this.now() - this.maxAgeMs;
    const filtered = merged.filter((event) => Date.parse(event.at) >= cutoff);
    const capped =
      filtered.length > this.maxEvents ? filtered.slice(filtered.length - this.maxEvents) : filtered;
    this.events.set(key, capped);
  }

  /** Return events for a sandbox, newest first. */
  list(target: SandboxKey): TimelineEvent[] {
    const events = this.events.get(keyOf(target)) ?? [];
    return [...events].reverse();
  }

  clear(): void {
    this.events.clear();
  }
}
