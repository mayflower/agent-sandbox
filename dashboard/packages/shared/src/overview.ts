import { getAgeSeconds } from "./helpers.js";
import { normalizeClaims, normalizeSandboxes, normalizeTemplates, normalizeWarmPools } from "./normalizers.js";
import type { InventorySnapshot, OverviewSnapshot, StatDatum, WarmPoolBarDatum } from "./types.js";

function toStatData(record: Record<string, number>): StatDatum[] {
  return Object.entries(record).map(([label, value]) => ({ label, value }));
}

function getAgeBucket(ageSeconds: number): string {
  if (ageSeconds < 15 * 60) {
    return "<15m";
  }
  if (ageSeconds < 60 * 60) {
    return "15m-1h";
  }
  if (ageSeconds < 6 * 60 * 60) {
    return "1h-6h";
  }
  return "6h+";
}

function getShutdownBucket(shutdownTime: string | undefined, now: Date): string {
  if (!shutdownTime) {
    return "none";
  }

  const diffSeconds = Math.floor((Date.parse(shutdownTime) - now.getTime()) / 1000);
  if (diffSeconds < 0) {
    return "overdue";
  }
  if (diffSeconds < 15 * 60) {
    return "<15m";
  }
  if (diffSeconds < 60 * 60) {
    return "15m-1h";
  }
  return "1h+";
}

export function buildOverviewSnapshot(snapshot: InventorySnapshot, now = new Date()): OverviewSnapshot {
  const sandboxes = normalizeSandboxes(snapshot, now);
  const claims = normalizeClaims(snapshot, now);
  const warmPools = normalizeWarmPools(snapshot, now);
  const templates = normalizeTemplates(snapshot, now);

  const sandboxesByStatus: Record<string, number> = {};
  const sandboxesByTemplate: Record<string, number> = {};
  const sandboxAgeBuckets: Record<string, number> = {};
  const sandboxShutdownBuckets: Record<string, number> = {};
  const claimsByState: Record<string, number> = {};

  for (const sandbox of sandboxes) {
    const statusKey = `${sandbox.objectState}/${sandbox.runtimeState}`;
    sandboxesByStatus[statusKey] = (sandboxesByStatus[statusKey] ?? 0) + 1;
    sandboxesByTemplate[sandbox.templateRef ?? "unmapped"] = (sandboxesByTemplate[sandbox.templateRef ?? "unmapped"] ?? 0) + 1;
    sandboxAgeBuckets[getAgeBucket(sandbox.ageSeconds)] = (sandboxAgeBuckets[getAgeBucket(sandbox.ageSeconds)] ?? 0) + 1;
    const shutdownBucket = getShutdownBucket(sandbox.shutdownTime, now);
    sandboxShutdownBuckets[shutdownBucket] = (sandboxShutdownBuckets[shutdownBucket] ?? 0) + 1;
  }

  for (const claim of claims) {
    claimsByState[claim.state] = (claimsByState[claim.state] ?? 0) + 1;
  }

  const warmPoolDesiredVsReady: WarmPoolBarDatum[] = warmPools.map((warmPool) => ({
    label: warmPool.name,
    desired: warmPool.desiredReplicas,
    ready: warmPool.readyReplicas,
  }));

  return {
    totals: {
      activeSandboxes: sandboxes.filter((sandbox) => sandbox.objectState === "active").length,
      runtimeReadySandboxes: sandboxes.filter((sandbox) => sandbox.effectiveReady).length,
      runtimeMissingSandboxes: sandboxes.filter((sandbox) => sandbox.runtimeState === "missing").length,
      pendingClaims: claims.filter((claim) => claim.state === "pending").length,
      claimsWithReadinessMismatch: claims.filter((claim) => claim.readinessMismatch).length,
      warmPoolReadyTotal: warmPools.reduce((sum, warmPool) => sum + warmPool.readyReplicas, 0),
      warmPoolDesiredTotal: warmPools.reduce((sum, warmPool) => sum + warmPool.desiredReplicas, 0),
      templatesInUse: templates.filter(
        (template) => template.activeClaims > 0 || template.activeSandboxes > 0 || template.activeWarmPools > 0,
      ).length,
    },
    charts: {
      sandboxesByStatus: toStatData(sandboxesByStatus),
      sandboxesByTemplate: toStatData(sandboxesByTemplate),
      sandboxAgeBuckets: toStatData(sandboxAgeBuckets),
      sandboxShutdownBuckets: toStatData(sandboxShutdownBuckets),
      claimsByState: toStatData(claimsByState),
      warmPoolDesiredVsReady,
    },
  };
}
