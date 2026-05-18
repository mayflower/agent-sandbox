import { describe, expect, it } from "vitest";
import type { InventorySnapshot, RawSandbox } from "@agent-sandbox/dashboard-shared";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared/fixtures";
import { SnapshotDiffEventSource } from "../timeline/event-sources/snapshot-diff.js";

function withRuntimeBroken(snapshot: InventorySnapshot, sandboxName: string): InventorySnapshot {
  const sandboxes = snapshot.sandboxes.map((sandbox) => {
    if (sandbox.metadata.name !== sandboxName) return sandbox;
    const annotations = { ...(sandbox.metadata.annotations ?? {}) };
    delete annotations["agents.x-k8s.io/pod-name"];
    const next: RawSandbox = {
      ...sandbox,
      metadata: { ...sandbox.metadata, annotations },
      status: { ...sandbox.status, conditions: [{ type: "Ready", status: "False" }] },
    };
    return next;
  });
  // Drop the matching Pod entry so the runtime resolves to "missing".
  const pods = snapshot.pods.filter((pod) => pod.metadata.name !== sandboxName);
  return { ...snapshot, sandboxes, pods };
}

describe("SnapshotDiffEventSource", () => {
  it("emits no events on the very first snapshot", () => {
    const source = new SnapshotDiffEventSource({ now: () => Date.parse("2026-04-15T10:00:00Z") });
    const events = source.consume(createFixtureSnapshot());
    expect(events.size).toBe(0);
  });

  it("emits a Ready=False transition when a sandbox loses its pod", () => {
    const source = new SnapshotDiffEventSource({ now: () => Date.parse("2026-04-15T10:00:00Z") });
    source.consume(createFixtureSnapshot());

    const next = withRuntimeBroken(createFixtureSnapshot(), "claim-ready");
    const events = source.consume(next);
    const claimEvents = events.get("demo/claim-ready") ?? [];
    expect(claimEvents.some((event) => event.reason === "Ready=False")).toBe(true);
  });

  it("emits a transition once a sandbox transitions from ready to runtime-missing", () => {
    const source = new SnapshotDiffEventSource({ now: () => Date.parse("2026-04-15T10:00:00Z") });
    source.consume(createFixtureSnapshot());
    const events = source.consume(withRuntimeBroken(createFixtureSnapshot(), "claim-ready"));
    expect(events.get("demo/claim-ready")).toBeDefined();
  });
});
