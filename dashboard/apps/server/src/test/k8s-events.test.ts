import { describe, expect, it } from "vitest";
import type { InventorySnapshot, RawEvent } from "@agent-sandbox/dashboard-shared";
import { eventsForSandbox } from "../timeline/event-sources/k8s-events.js";

function emptySnapshot(): InventorySnapshot {
  return {
    capabilities: {
      sandboxes: true,
      claims: false,
      warmPools: false,
      templates: false,
      events: true,
      controllerHealth: false,
    },
    sandboxes: [],
    claims: [],
    warmPools: [],
    templates: [],
    pods: [],
    services: [],
    pvcs: [],
    events: [],
    controllerHealth: null,
  };
}

function event(opts: Partial<RawEvent>): RawEvent {
  return {
    metadata: { name: "ev-1", namespace: "demo", uid: "u-1" },
    type: "Normal",
    reason: "Scheduled",
    note: "pod scheduled",
    eventTime: "2026-04-15T10:00:00Z",
    regarding: { kind: "Pod", name: "pod-1", namespace: "demo" },
    ...opts,
  };
}

describe("eventsForSandbox", () => {
  it("returns events for the sandbox itself", () => {
    const snapshot = {
      ...emptySnapshot(),
      events: [event({ regarding: { kind: "Sandbox", name: "sb-1", namespace: "demo" } })],
    };
    const events = eventsForSandbox(snapshot, { namespace: "demo", name: "sb-1", podName: "pod-1" });
    expect(events).toHaveLength(1);
    expect(events[0]!.resourceKind).toBe("Sandbox");
  });

  it("returns events for the sandbox's own pod via the annotation-derived name", () => {
    const snapshot = { ...emptySnapshot(), events: [event({})] };
    const events = eventsForSandbox(snapshot, { namespace: "demo", name: "sb-1", podName: "pod-1" });
    expect(events).toHaveLength(1);
    expect(events[0]!.resourceKind).toBe("Pod");
  });

  it("filters out sibling-pod events whose name does not match the sandbox's pod name", () => {
    const snapshot = {
      ...emptySnapshot(),
      events: [event({ regarding: { kind: "Pod", name: "other-pod", namespace: "demo" } })],
    };
    expect(eventsForSandbox(snapshot, { namespace: "demo", name: "sb-1", podName: "pod-1" })).toEqual([]);
  });

  it("filters out events from other namespaces", () => {
    const snapshot = {
      ...emptySnapshot(),
      events: [event({ regarding: { kind: "Pod", name: "pod-1", namespace: "other" } })],
    };
    expect(eventsForSandbox(snapshot, { namespace: "demo", name: "sb-1", podName: "pod-1" })).toEqual([]);
  });

  it("maps Warning type to severity=warning", () => {
    const snapshot = { ...emptySnapshot(), events: [event({ type: "Warning" })] };
    const events = eventsForSandbox(snapshot, { namespace: "demo", name: "sb-1", podName: "pod-1" });
    expect(events[0]!.severity).toBe("warning");
  });
});
