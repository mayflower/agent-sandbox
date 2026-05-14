import { describe, expect, it } from "vitest";
import {
  buildIdentity,
  DEFAULT_TENANCY_CONFIG,
  type Identity,
} from "@agent-sandbox/dashboard-shared";
import { filterSnapshotForIdentity as serverFilter } from "../identity/filter-snapshot.js";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";

describe("buildIdentity", () => {
  it("returns synthetic operator when tenancy is disabled", () => {
    const identity = buildIdentity({}, { ...DEFAULT_TENANCY_CONFIG, enabled: false }, []);
    expect(identity.role).toBe("operator");
    expect(identity.namespaces).toEqual([]);
  });

  it("returns tenant role with scoped namespaces when matching label is found", () => {
    const identity = buildIdentity(
      { "x-forwarded-user": "alice" },
      { ...DEFAULT_TENANCY_CONFIG, enabled: true },
      [
        { name: "team-a", labels: { "agent-sandbox.x-k8s.io/tenant": "alice" } },
        { name: "team-b", labels: { "agent-sandbox.x-k8s.io/tenant": "bob" } },
      ],
    );
    expect(identity.role).toBe("tenant");
    expect(identity.namespaces).toEqual(["team-a"]);
  });

  it("escalates to operator when user is in the operators group", () => {
    const identity = buildIdentity(
      { "x-forwarded-user": "carol", "x-forwarded-groups": "engineering,sandbox-operators" },
      { ...DEFAULT_TENANCY_CONFIG, enabled: true },
      [{ name: "team-c" }],
    );
    expect(identity.role).toBe("operator");
  });
});

describe("filterSnapshotForIdentity", () => {
  it("returns the snapshot unchanged for operators", () => {
    const snapshot = createFixtureSnapshot();
    const identity: Identity = { user: "op", role: "operator", namespaces: [], groups: [] };
    expect(serverFilter(snapshot, identity)).toBe(snapshot);
  });

  it("restricts a snapshot to the tenant's namespaces", () => {
    const snapshot = createFixtureSnapshot();
    const known = [...new Set(snapshot.sandboxes.map((s) => s.metadata.namespace ?? "default"))];
    const tenant: Identity = { user: "alice", role: "tenant", namespaces: [known[0]!], groups: [] };
    const filtered = serverFilter(snapshot, tenant);
    expect(filtered.sandboxes.every((s) => (s.metadata.namespace ?? "default") === known[0])).toBe(true);
  });
});
