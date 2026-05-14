import { describe, expect, it } from "vitest";
import { TimelineStore } from "../timeline/timeline-store.js";
import type { TimelineEvent } from "@agent-sandbox/dashboard-shared";

function event(id: string, at: string): TimelineEvent {
  return {
    id,
    kind: "pod",
    at,
    resourceKind: "Pod",
    resourceName: "pod-1",
    namespace: "demo",
    reason: "Scheduled",
    message: "ok",
    severity: "info",
  };
}

describe("TimelineStore", () => {
  it("stores and deduplicates events per sandbox", () => {
    const store = new TimelineStore({ now: () => Date.parse("2026-04-15T10:00:00Z") });
    store.ingest({ namespace: "demo", name: "sb" }, [
      event("a", "2026-04-15T09:00:00Z"),
      event("a", "2026-04-15T09:00:00Z"),
    ]);
    const list = store.list({ namespace: "demo", name: "sb" });
    expect(list).toHaveLength(1);
  });

  it("evicts events older than the max age", () => {
    const store = new TimelineStore({ maxAgeMs: 60_000, now: () => Date.parse("2026-04-15T10:01:00Z") });
    store.ingest({ namespace: "demo", name: "sb" }, [event("old", "2026-04-15T09:30:00Z")]);
    expect(store.list({ namespace: "demo", name: "sb" })).toHaveLength(0);
  });

  it("respects max events per sandbox", () => {
    const store = new TimelineStore({ maxEventsPerSandbox: 3, now: () => Date.parse("2026-04-15T10:00:00Z") });
    store.ingest(
      { namespace: "demo", name: "sb" },
      Array.from({ length: 10 }, (_, index) => event(`e${index}`, `2026-04-15T09:5${index}:00Z`)),
    );
    expect(store.list({ namespace: "demo", name: "sb" })).toHaveLength(3);
  });
});
