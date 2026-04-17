import { describe, expect, it } from "vitest";

import { buildOverviewSnapshot, classifyProblems, createFixtureSnapshot, groupProblems, mapEvents, normalizeClaims, normalizeSandboxes, normalizeTemplates, normalizeWarmPools } from "../index.js";

describe("shared dashboard domain helpers", () => {
  const now = new Date("2026-04-15T12:00:00Z");

  it("normalizes sandbox runtime and ownership states", () => {
    const sandboxes = normalizeSandboxes(createFixtureSnapshot(), now);
    const retained = sandboxes.find((sandbox) => sandbox.name === "retained-sbx");
    const claimReady = sandboxes.find((sandbox) => sandbox.name === "claim-ready");
    const warmPoolMember = sandboxes.find((sandbox) => sandbox.name === "pool-sbx-ready");
    const directSandbox = sandboxes.find((sandbox) => sandbox.name === "retained-sbx");

    expect(retained?.runtimeState).toBe("missing");
    expect(retained?.objectState).toBe("retained");
    expect(claimReady?.effectiveReady).toBe(true);
    expect(claimReady?.serviceFQDN).toContain("cluster.local");
    expect(warmPoolMember?.ownerKind).toBe("warm-pool");
    expect(directSandbox?.ownerKind).toBe("direct");
  });

  it("normalizes claims, warm pools, templates, and problems", () => {
    const snapshot = createFixtureSnapshot();
    const claims = normalizeClaims(snapshot, now);
    const mismatch = claims.find((claim) => claim.name === "mismatch-claim");
    const pending = claims.find((claim) => claim.name === "pending-claim");
    const warmPools = normalizeWarmPools(snapshot, now);
    const templates = normalizeTemplates(snapshot, now);
    const problems = classifyProblems(snapshot, now);

    expect(mismatch?.readinessMismatch).toBe(true);
    expect(mismatch?.shutdownPolicy).toBe("DeleteForeground");
    expect(pending?.state).toBe("pending");
    expect(warmPools[0]?.fillRatio).toBe(0.5);
    expect(warmPools[0]?.memberSandboxes[0]?.name).toBe("pool-sbx-ready");
    expect(templates.find((template) => template.name === "python-secure")?.networkPolicyMode).toBe("secure-default");
    expect(templates.find((template) => template.name === "custom-net")?.networkPolicyMode).toBe("custom");
    expect(templates.find((template) => template.name === "external-template")?.networkPolicyMode).toBe("external");
    expect(problems.some((problem) => problem.kind === "retained-without-runtime")).toBe(true);
    expect(problems.some((problem) => problem.kind === "claim-runtime-mismatch")).toBe(true);
    expect(problems.some((problem) => problem.kind === "warm-pool-underfilled")).toBe(true);
    expect(problems.some((problem) => problem.kind === "unresolved-template-link")).toBe(true);
  });

  it("builds deterministic overview data and event views", () => {
    const snapshot = createFixtureSnapshot();
    const overview = buildOverviewSnapshot(snapshot, now);
    const events = mapEvents(snapshot);

    expect(overview.totals.activeSandboxes).toBe(4);
    expect(overview.totals.runtimeReadySandboxes).toBe(2);
    expect(overview.totals.runtimeMissingSandboxes).toBe(3);
    expect(overview.totals.claimsWithReadinessMismatch).toBe(1);
    expect(overview.totals.templatesInUse).toBe(2);
    expect(overview.charts.sandboxAgeBuckets.some((bucket) => bucket.label === "1h-6h")).toBe(true);
    expect(overview.charts.sandboxShutdownBuckets.some((bucket) => bucket.label === "overdue")).toBe(true);
    expect(overview.charts.warmPoolDesiredVsReady[0]).toEqual({
      label: "fast-pool",
      desired: 2,
      ready: 1,
    });
    expect(events[0]?.resourceKind).toBe("SandboxClaim");
    expect(events[0]?.message).toContain("runtime");
  });

  it("groups problems by kind with highest severity first", () => {
    const snapshot = createFixtureSnapshot();
    const problems = classifyProblems(snapshot, now);
    const groups = groupProblems(problems);

    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.count).toBe(group.items.length);
    }
    const rank = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < groups.length; i += 1) {
      expect(rank[groups[i - 1]!.severity] <= rank[groups[i]!.severity]).toBe(true);
    }
  });

  it("builds phase breakdown and unmapped totals on overview", () => {
    const snapshot = createFixtureSnapshot();
    const overview = buildOverviewSnapshot(snapshot, now);

    expect(overview.totals.totalSandboxes).toBe(5);
    expect(overview.totals.unmappedSandboxes).toBeGreaterThanOrEqual(0);
    expect(overview.phaseBreakdown.reduce((sum, entry) => sum + entry.count, 0)).toBe(overview.totals.totalSandboxes);
    const readyEntry = overview.phaseBreakdown.find((entry) => entry.phase === "ready");
    expect(readyEntry?.count).toBe(overview.totals.runtimeReadySandboxes);
  });

  it("keeps unknown event kinds and only uses controller owners marked true", () => {
    const snapshot = createFixtureSnapshot();
    snapshot.events.unshift({
      metadata: { name: "pvc-event", namespace: "demo", creationTimestamp: "2026-04-15T12:00:01Z" },
      regarding: { kind: "PersistentVolumeClaim", name: "demo-pvc", namespace: "demo" },
      note: "PVC changed",
    });
    snapshot.sandboxes.push({
      metadata: {
        name: "ambiguous-owner",
        namespace: "demo",
        creationTimestamp: "2026-04-15T11:00:00Z",
        ownerReferences: [
          { kind: "SandboxClaim", name: "wrong-claim" },
          { kind: "SandboxWarmPool", name: "fast-pool", controller: true },
        ],
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [{ name: "main", image: "busybox" }],
          },
        },
      },
      status: {},
    });

    const events = mapEvents(snapshot);
    const sandboxes = normalizeSandboxes(snapshot, now);
    const ambiguous = sandboxes.find((sandbox) => sandbox.name === "ambiguous-owner");

    expect(events[0]?.resourceKind).toBe("PersistentVolumeClaim");
    expect(ambiguous?.ownerKind).toBe("warm-pool");
    expect(ambiguous?.warmPoolName).toBe("fast-pool");
  });
});
