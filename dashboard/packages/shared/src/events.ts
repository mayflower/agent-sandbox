import { getEventTarget, getNamespace } from "./helpers.js";
import type { EventResourceKind, EventView, InventorySnapshot } from "./types.js";

const EVENT_RESOURCE_KINDS = new Set<EventResourceKind>([
  "Sandbox",
  "SandboxClaim",
  "SandboxWarmPool",
  "SandboxTemplate",
  "Pod",
  "Router",
]);

function toEventResourceKind(kind: string | undefined): EventResourceKind | undefined {
  if (kind === undefined) return undefined;
  return EVENT_RESOURCE_KINDS.has(kind as EventResourceKind) ? (kind as EventResourceKind) : undefined;
}

export function mapEvents(snapshot: InventorySnapshot): EventView[] {
  const views: EventView[] = [];
  for (const event of snapshot.events) {
    const target = getEventTarget(event);
    const kind = toEventResourceKind(target.kind);
    if (!kind) continue;
    views.push({
      namespace: target.namespace ?? getNamespace(event.metadata),
      resourceKind: kind,
      resourceName: target.name ?? event.metadata.name,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.type ? { type: event.type } : {}),
      message: event.note ?? event.message ?? "No event message available.",
      ...(event.eventTime ?? event.metadata.creationTimestamp
        ? { eventTime: event.eventTime ?? event.metadata.creationTimestamp }
        : {}),
    });
  }
  return views.sort(
    (left, right) =>
      Date.parse(right.eventTime ?? "1970-01-01T00:00:00Z") -
      Date.parse(left.eventTime ?? "1970-01-01T00:00:00Z"),
  );
}
