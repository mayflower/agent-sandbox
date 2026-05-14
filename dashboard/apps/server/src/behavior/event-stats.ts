import {
  buildTemplateBehavior,
  getEventTarget,
  normalizeAll,
  type InventorySnapshot,
  type TemplateBehavior,
  type TimelineEvent,
} from "@agent-sandbox/dashboard-shared";

const SUPPORTED_KINDS = new Set<string>(["Sandbox", "SandboxClaim", "SandboxWarmPool", "Pod"]);

/** Build TemplateBehavior from snapshot events for resources belonging to the template. */
export function buildTemplateBehaviorFromSnapshot(
  snapshot: InventorySnapshot,
  templateName: string,
  now = new Date(),
): TemplateBehavior {
  const inventory = normalizeAll(snapshot, now);
  const sandboxNames = new Set(
    inventory.sandboxes
      .filter((sandbox) => sandbox.templateRef === templateName)
      .map((sandbox) => `${sandbox.namespace}/${sandbox.name}`),
  );

  const matchingEvents: TimelineEvent[] = [];
  for (const event of snapshot.events) {
    const target = getEventTarget(event);
    if (!target.kind || !SUPPORTED_KINDS.has(target.kind)) continue;
    if (target.kind === "Sandbox") {
      const key = `${target.namespace ?? "default"}/${target.name}`;
      if (!sandboxNames.has(key)) continue;
    }
    matchingEvents.push({
      id: `evt:${event.metadata.uid ?? event.metadata.name}`,
      kind: target.kind === "Pod" ? "pod" : "sandbox",
      at: event.eventTime ?? event.metadata.creationTimestamp ?? new Date(0).toISOString(),
      resourceKind: target.kind === "Pod" ? "Pod" : "Sandbox",
      resourceName: target.name ?? event.metadata.name,
      namespace: target.namespace ?? event.metadata.namespace ?? "default",
      reason: event.reason ?? "Event",
      message: event.note ?? event.message ?? "",
      severity: event.type === "Warning" ? "warning" : "info",
    });
  }

  // Derive simple session-length & cold-start lists (best-effort heuristics).
  const sessionDurations: number[] = [];
  const coldStarts: number[] = [];
  for (const sandbox of inventory.sandboxes) {
    if (sandbox.templateRef !== templateName) continue;
    if (sandbox.objectState === "expired" || sandbox.objectState === "retained") {
      sessionDurations.push(sandbox.ageSeconds);
    }
    if (sandbox.runtimeState === "starting" && sandbox.ageSeconds > 0) {
      coldStarts.push(sandbox.ageSeconds);
    }
  }

  return buildTemplateBehavior(templateName, matchingEvents, sessionDurations, coldStarts);
}
