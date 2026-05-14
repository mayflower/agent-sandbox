import type { TimelineEvent } from "./types.js";

export function compareEventsAsc(left: TimelineEvent, right: TimelineEvent): number {
  return Date.parse(left.at) - Date.parse(right.at);
}

export function compareEventsDesc(left: TimelineEvent, right: TimelineEvent): number {
  return Date.parse(right.at) - Date.parse(left.at);
}

/** Dedupe by `id`, first occurrence wins (callers push in priority order). */
export function dedupeEvents(events: Iterable<TimelineEvent>): TimelineEvent[] {
  const seen = new Map<string, TimelineEvent>();
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.set(event.id, event);
    }
  }
  return [...seen.values()];
}
