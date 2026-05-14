import { describe, expect, it } from "vitest";
import {
  captureSnapshot,
  createFixtureSnapshot,
  diffSnapshots,
} from "@agent-sandbox/dashboard-shared";

describe("diffSnapshots", () => {
  it("detects added and removed sandboxes", () => {
    const before = createFixtureSnapshot();
    const sandboxes = before.sandboxes.slice(0, before.sandboxes.length - 1);
    const after = { ...before, sandboxes };

    const diff = diffSnapshots(
      captureSnapshot(before, "2026-04-15T10:00:00Z"),
      captureSnapshot(after, "2026-04-15T10:05:00Z"),
    );
    expect(diff.added).toHaveLength(0);
    expect(diff.removed.length).toBeGreaterThanOrEqual(1);
    expect(diff.removed.every((entry) => entry.resourceKind === "Sandbox")).toBe(true);
  });

  it("returns empty arrays when snapshots are identical", () => {
    const snapshot = createFixtureSnapshot();
    const diff = diffSnapshots(
      captureSnapshot(snapshot, "t1"),
      captureSnapshot(snapshot, "t2"),
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});
