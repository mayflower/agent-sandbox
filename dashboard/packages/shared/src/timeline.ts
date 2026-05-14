import type { TimelineEvent } from "./types.js";

export function compareEventsAsc(left: TimelineEvent, right: TimelineEvent): number {
  return Date.parse(left.at) - Date.parse(right.at);
}

export function compareEventsDesc(left: TimelineEvent, right: TimelineEvent): number {
  return Date.parse(right.at) - Date.parse(left.at);
}

/**
 * Deduplicate timeline events by id. The same logical event can arrive from
 * multiple sources (K8s events watch + snapshot diff), so we collapse on a
 * stable id. Keeps the first seen entry (sources push in priority order).
 */
export function dedupeEvents(events: Iterable<TimelineEvent>): TimelineEvent[] {
  const seen = new Map<string, TimelineEvent>();
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.set(event.id, event);
    }
  }
  return [...seen.values()];
}
