import { describe, expect, it } from "vitest";
import { createFixtureSnapshot, type InventoryProvider } from "@agent-sandbox/dashboard-shared";
import { HistoryStore } from "../history/history-store.js";
import { TimelineStore } from "../timeline/timeline-store.js";
import { startPollLoop } from "../history/poll-loop.js";

function fakeProvider(snapshots: ReturnType<typeof createFixtureSnapshot>[], failOn: Set<number>): InventoryProvider {
  let index = 0;
  return {
    async getCapabilities() {
      return snapshots[0]!.capabilities;
    },
    async getSnapshot() {
      const callIndex = index++;
      if (failOn.has(callIndex)) {
        throw new Error(`scheduled failure on tick ${callIndex}`);
      }
      return snapshots[Math.min(callIndex, snapshots.length - 1)]!;
    },
  };
}

describe("startPollLoop", () => {
  it("records a metrics row on each successful tick", async () => {
    const history = new HistoryStore();
    const timeline = new TimelineStore();
    const provider = fakeProvider([createFixtureSnapshot()], new Set());
    const handle = startPollLoop({
      provider,
      historyStore: history,
      timelineStore: timeline,
      getCostRates: () => null,
      intervalMs: 100_000,
      runImmediately: false,
    });
    await handle.tick();
    expect(history.internalState().fastCount).toBeGreaterThan(0);
    expect(handle.health().lastSuccessAt).not.toBeNull();
    expect(handle.health().consecutiveFailures).toBe(0);
    handle.stop();
  });

  it("recovers after a transient provider failure and records on the next success", async () => {
    const history = new HistoryStore();
    const timeline = new TimelineStore();
    // Calls: [0] = explicit success, [1] = explicit fail, [2] = explicit success.
    const provider = fakeProvider(
      [createFixtureSnapshot(), createFixtureSnapshot(), createFixtureSnapshot()],
      new Set([1]),
    );
    const handle = startPollLoop({
      provider,
      historyStore: history,
      timelineStore: timeline,
      getCostRates: () => null,
      intervalMs: 100_000,
      runImmediately: false,
    });

    await handle.tick();
    const baseCount = history.internalState().fastCount;
    expect(baseCount).toBeGreaterThan(0);

    await handle.tick();
    expect(handle.health().consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(history.internalState().fastCount).toBe(baseCount);

    await handle.tick();
    expect(handle.health().consecutiveFailures).toBe(0);
    expect(history.internalState().fastCount).toBeGreaterThan(baseCount);
    handle.stop();
  });

  it("omits cost row when getCostRates returns null", async () => {
    const history = new HistoryStore();
    const timeline = new TimelineStore();
    const provider = fakeProvider([createFixtureSnapshot()], new Set());
    const handle = startPollLoop({
      provider,
      historyStore: history,
      timelineStore: timeline,
      getCostRates: () => null,
      intervalMs: 100_000,
      runImmediately: false,
    });
    await handle.tick();
    const row = history.series("15s").rows[0]!;
    expect(row.costPerHourUsd).toBe(0);
    expect(row.idleSpendPerHourUsd).toBe(0);
    handle.stop();
  });
});
