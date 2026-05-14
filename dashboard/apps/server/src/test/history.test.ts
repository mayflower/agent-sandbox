import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";
import { HistoryStore, FAST_BUFFER_CAPACITY } from "../history/history-store.js";

describe("HistoryStore", () => {
  it("records a metrics row per snapshot", () => {
    const store = new HistoryStore();
    const snapshot = createFixtureSnapshot();
    store.record({ at: new Date("2026-04-15T10:00:00Z"), snapshot });
    const series = store.series("15s");
    expect(series.rows).toHaveLength(1);
    expect(series.rows[0]!.totalSandboxes).toBeGreaterThan(0);
  });

  it("rolls over the fast ring at FAST_BUFFER_CAPACITY", () => {
    const store = new HistoryStore();
    const snapshot = createFixtureSnapshot();
    const start = Date.parse("2026-04-15T10:00:00Z");
    for (let i = 0; i < FAST_BUFFER_CAPACITY + 5; i += 1) {
      store.record({ at: new Date(start + i * 15_000), snapshot });
    }
    expect(store.internalState().fastCount).toBe(FAST_BUFFER_CAPACITY);
  });

  it("only writes one slow-ring row every five minutes", () => {
    const store = new HistoryStore();
    const snapshot = createFixtureSnapshot();
    const start = Date.parse("2026-04-15T10:00:00Z");
    // 20 minutes of 15s ticks → 80 fast rows but only 4 slow rows
    for (let i = 0; i < 80; i += 1) {
      store.record({ at: new Date(start + i * 15_000), snapshot });
    }
    expect(store.internalState().slowCount).toBeLessThanOrEqual(5);
    expect(store.internalState().slowCount).toBeGreaterThanOrEqual(3);
  });

  it("returns the full snapshot at a given time within tolerance", () => {
    const store = new HistoryStore();
    const snapshot = createFixtureSnapshot();
    const at = new Date("2026-04-15T10:00:30Z");
    store.record({ at, snapshot });
    expect(store.snapshotAt(at.getTime())).toBe(snapshot);
    expect(store.snapshotAt(at.getTime() + 5 * 60_000)).toBeUndefined();
  });

  it("persists rows to disk and replays them on restart", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "history-store-test-"));
    try {
      const store = new HistoryStore({ dataDir });
      const snapshot = createFixtureSnapshot();
      const at = new Date("2026-04-15T10:00:00Z");
      store.record({ at, snapshot });

      const reopened = new HistoryStore({ dataDir });
      const series = reopened.series("15s");
      expect(series.rows.length).toBe(1);
      expect(series.rows[0]!.totalSandboxes).toBe(store.series("15s").rows[0]!.totalSandboxes);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
