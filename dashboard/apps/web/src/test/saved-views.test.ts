import { beforeEach, describe, expect, it } from "vitest";
import { ackProblem, clearAck, listAcks, listSavedViews, saveView, deleteSavedView } from "../lib/saved-views";
import { DEFAULT_URL_STATE } from "../lib/url-state";

beforeEach(() => {
  window.localStorage.clear();
});

describe("saved views", () => {
  it("round-trips a saved view through localStorage", () => {
    saveView({ id: "v1", name: "My team", state: { ...DEFAULT_URL_STATE, namespace: "team-a" } });
    const all = listSavedViews();
    expect(all).toHaveLength(1);
    expect(all[0]!.state.namespace).toBe("team-a");
  });

  it("deletes a saved view", () => {
    saveView({ id: "v2", name: "x", state: DEFAULT_URL_STATE });
    deleteSavedView("v2");
    expect(listSavedViews()).toEqual([]);
  });
});

describe("problem acks", () => {
  it("stores acks with expiry", () => {
    ackProblem("runtime-missing", "investigating", 100_000);
    const acks = listAcks();
    expect(acks).toHaveLength(1);
    expect(acks[0]!.reason).toBe("investigating");
    expect(acks[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("expires after duration", () => {
    ackProblem("runtime-missing", undefined, 0);
    // expiresAt === now so the filter drops it immediately
    expect(listAcks()).toHaveLength(0);
  });

  it("clears a single ack", () => {
    ackProblem("runtime-missing", undefined, 60_000);
    ackProblem("warm-pool-underfilled", undefined, 60_000);
    clearAck("runtime-missing");
    expect(listAcks().map((entry) => entry.kind)).toEqual(["warm-pool-underfilled"]);
  });
});
