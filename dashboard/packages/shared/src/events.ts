import { getEventTarget, getNamespace } from "./helpers.js";
import type { EventView, InventorySnapshot } from "./types.js";

function normalizeResourceKind(kind: string | undefined): EventView["resourceKind"] {
  return kind ?? "Other";
}

export function mapEvents(snapshot: InventorySnapshot): EventView[] {
  return snapshot.events
    .map((event) => {
      const target = getEventTarget(event);
      return {
        namespace: target.namespace ?? getNamespace(event.metadata),
        resourceKind: normalizeResourceKind(target.kind),
        resourceName: target.name ?? event.metadata.name,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.type ? { type: event.type } : {}),
        message: event.note ?? event.message ?? "No event message available.",
        ...(event.eventTime ?? event.metadata.creationTimestamp
          ? { eventTime: event.eventTime ?? event.metadata.creationTimestamp }
          : {}),
      };
    })
    .sort((left, right) => Date.parse(right.eventTime ?? "1970-01-01T00:00:00Z") - Date.parse(left.eventTime ?? "1970-01-01T00:00:00Z"));
}
