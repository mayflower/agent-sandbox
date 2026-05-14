import {
  getEventTarget,
  type InventorySnapshot,
  type RawEvent,
  type SandboxResourceKind,
  type TimelineEvent,
} from "@agent-sandbox/dashboard-shared";

const SUPPORTED_KINDS = new Set<string>(["Sandbox", "SandboxClaim", "SandboxWarmPool", "Pod"]);

function severityFromType(type: string | undefined): TimelineEvent["severity"] {
  if (type === "Warning") return "warning";
  if (type === "Error") return "error";
  return "info";
}

function resourceKindFrom(kind: string | undefined): TimelineEvent["resourceKind"] | undefined {
  if (!kind) return undefined;
  if (kind === "Pod") return "Pod";
  if (kind === "Sandbox" || kind === "SandboxClaim" || kind === "SandboxWarmPool" || kind === "SandboxTemplate") {
    return kind as SandboxResourceKind;
  }
  return undefined;
}

/** Build TimelineEvent[] from snapshot events for the given sandbox identity. */
export function eventsForSandbox(
  snapshot: InventorySnapshot,
  sandbox: { namespace: string; name: string; podName?: string },
): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  for (const event of snapshot.events) {
    const target = getEventTarget(event);
    if (!target.kind || !SUPPORTED_KINDS.has(target.kind)) continue;
    const targetNamespace = target.namespace ?? event.metadata.namespace ?? "default";
    const targetName = target.name ?? event.metadata.name;
    if (targetNamespace !== sandbox.namespace) continue;
    const isSelf = target.kind === "Sandbox" && targetName === sandbox.name;
    const isOwnPod = target.kind === "Pod" && targetName === sandbox.podName;
    if (!isSelf && !isOwnPod) continue;
    result.push(buildTimelineEvent(event, target.kind));
  }
  return result;
}

function buildTimelineEvent(event: RawEvent, kind: string): TimelineEvent {
  const id = `evt:${event.metadata.uid ?? event.metadata.name}:${event.reason ?? "unknown"}:${event.eventTime ?? event.metadata.creationTimestamp ?? ""}`;
  const resourceKind = resourceKindFrom(kind) ?? "Pod";
  return {
    id,
    kind: kind === "Pod" ? "pod" : kind === "SandboxClaim" ? "claim" : kind === "SandboxWarmPool" ? "warmpool" : "sandbox",
    at: event.eventTime ?? event.metadata.creationTimestamp ?? new Date(0).toISOString(),
    resourceKind,
    resourceName: getEventTarget(event).name ?? event.metadata.name,
    namespace: getEventTarget(event).namespace ?? event.metadata.namespace ?? "default",
    reason: event.reason ?? "Event",
    message: event.note ?? event.message ?? "(no message)",
    severity: severityFromType(event.type),
  };
}
