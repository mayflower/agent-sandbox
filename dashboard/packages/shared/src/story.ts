import { compareEventsDesc } from "./timeline.js";
import type { StoryRow, TimelineEvent } from "./types.js";

const VERB_MAP: Record<string, string> = {
  PodScheduled: "Pod scheduled",
  Pulling: "Pulling image",
  Pulled: "Image pulled",
  Created: "Container created",
  Started: "Container started",
  Killing: "Killing container",
  BackOff: "Back-off",
  Unhealthy: "Probe unhealthy",
  FailedScheduling: "Scheduling failed",
  ImagePullBackOff: "Image pull back-off",
  CrashLoopBackOff: "Crash-loop back-off",
  // Sandbox transitions injected by snapshot-diff source
  "Ready=True": "Sandbox became ready",
  "Ready=False": "Sandbox lost readiness",
  Reconciling: "Controller reconciling",
  Expired: "Sandbox expired",
  Retained: "Sandbox retained",
  Deleting: "Sandbox deleting",
  // Claim transitions
  "ClaimReady=True": "Claim ready",
  "ClaimReady=False": "Claim no longer ready",
  Pending: "Claim pending",
  // Router
  Request: "Sandbox handled request",
};

function verbFor(event: TimelineEvent): string {
  return VERB_MAP[event.reason] ?? event.reason;
}

export function compileStory(events: TimelineEvent[]): StoryRow[] {
  return [...events].sort(compareEventsDesc).map((event) => ({
    at: event.at,
    verb: verbFor(event),
    detail: event.message,
    severity: event.severity,
    source: event,
  }));
}
