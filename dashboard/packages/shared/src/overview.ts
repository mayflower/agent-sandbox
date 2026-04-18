import { normalizeAll } from "./normalizers.js";
import type {
  ClaimLiveView,
  InventorySnapshot,
  OverviewSnapshot,
  PendingClaimReason,
  PhaseDatum,
  SandboxLiveView,
  SandboxPhase,
  StatDatum,
  WarmPoolBarDatum,
  WarmPoolLiveView,
} from "./types.js";

const PHASE_ORDER: SandboxPhase[] = [
  "ready",
  "starting",
  "retained",
  "stopped",
  "terminating",
  "runtime-missing",
  "expired",
  "deleting",
];

const PHASE_LABELS: Record<SandboxPhase, string> = {
  ready: "Ready",
  starting: "Starting",
  retained: "Retained",
  stopped: "Stopped",
  terminating: "Terminating",
  "runtime-missing": "Runtime missing",
  expired: "Expired",
  deleting: "Deleting",
};

function resolvePhase(sandbox: SandboxLiveView): SandboxPhase {
  if (sandbox.objectState === "deleting") return "deleting";
  if (sandbox.objectState === "expired") return "expired";
  if (sandbox.objectState === "retained") return "retained";
  if (sandbox.runtimeState === "ready") return "ready";
  if (sandbox.runtimeState === "starting") return "starting";
  if (sandbox.runtimeState === "terminating") return "terminating";
  if (sandbox.runtimeState === "stopped") return "stopped";
  return "runtime-missing";
}

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

export interface LiveOverview {
  totals: OverviewSnapshot["totals"];
  phaseBreakdown: PhaseDatum[];
  pendingClaimsByReason: PendingClaimReason[];
}

function computePhaseBreakdown(sandboxes: SandboxLiveView[]): PhaseDatum[] {
  const phaseCounts = new Map<SandboxPhase, number>();
  for (const sandbox of sandboxes) {
    const phase = resolvePhase(sandbox);
    phaseCounts.set(phase, (phaseCounts.get(phase) ?? 0) + 1);
  }
  return PHASE_ORDER.filter((phase) => (phaseCounts.get(phase) ?? 0) > 0).map((phase) => ({
    phase,
    label: PHASE_LABELS[phase],
    count: phaseCounts.get(phase) ?? 0,
  }));
}

function computePendingClaimsByReason(claims: ClaimLiveView[]): PendingClaimReason[] {
  const map = new Map<string, PendingClaimReason>();
  for (const claim of claims) {
    if (claim.state !== "pending") continue;
    const reason = claim.rawReadyCondition?.reason?.trim() || "Unknown";
    let entry = map.get(reason);
    if (!entry) {
      entry = { reason, count: 0, claims: [] };
      map.set(reason, entry);
    }
    entry.count += 1;
    entry.claims.push({ namespace: claim.namespace, name: claim.name });
  }
  return [...map.values()].sort((left, right) => right.count - left.count);
}

function computeTotals(
  sandboxes: SandboxLiveView[],
  claims: ClaimLiveView[],
  warmPools: WarmPoolLiveView[],
  templatesInUse: number,
): OverviewSnapshot["totals"] {
  return {
    totalSandboxes: sandboxes.length,
    activeSandboxes: sandboxes.filter((sandbox) => sandbox.objectState === "active").length,
    runtimeReadySandboxes: sandboxes.filter((sandbox) => sandbox.effectiveReady).length,
    runtimeMissingSandboxes: sandboxes.filter((sandbox) => sandbox.runtimeState === "missing").length,
    pendingClaims: claims.filter((claim) => claim.state === "pending").length,
    claimsWithReadinessMismatch: claims.filter((claim) => claim.readinessMismatch).length,
    warmPoolReadyTotal: warmPools.reduce((sum, pool) => sum + pool.readyReplicas, 0),
    warmPoolDesiredTotal: warmPools.reduce((sum, pool) => sum + pool.desiredReplicas, 0),
    templatesInUse,
    unmappedSandboxes: sandboxes.filter((sandbox) => !sandbox.templateRef).length,
  };
}

export function computeLiveOverview(
  sandboxes: SandboxLiveView[],
  claims: ClaimLiveView[],
  warmPools: WarmPoolLiveView[],
): LiveOverview {
  const templatesInUse = new Set<string>();
  for (const sandbox of sandboxes) {
    if (sandbox.templateRef) templatesInUse.add(`${sandbox.namespace}/${sandbox.templateRef}`);
  }
  for (const claim of claims) {
    if (claim.templateRef) templatesInUse.add(`${claim.namespace}/${claim.templateRef}`);
  }
  for (const pool of warmPools) {
    if (pool.templateRef) templatesInUse.add(`${pool.namespace}/${pool.templateRef}`);
  }

  return {
    totals: computeTotals(sandboxes, claims, warmPools, templatesInUse.size),
    phaseBreakdown: computePhaseBreakdown(sandboxes),
    pendingClaimsByReason: computePendingClaimsByReason(claims),
  };
}

export function buildOverviewSnapshot(snapshot: InventorySnapshot, now = new Date()): OverviewSnapshot {
  const { sandboxes, claims, warmPools, templates } = normalizeAll(snapshot, now);

  const sandboxesByStatus: Record<string, number> = {};
  const sandboxesByTemplate: Record<string, number> = {};
  const sandboxAgeBuckets: Record<string, number> = {};
  const sandboxShutdownBuckets: Record<string, number> = {};
  const claimsByState: Record<string, number> = {};

  for (const sandbox of sandboxes) {
    const statusKey = `${sandbox.objectState}/${sandbox.runtimeState}`;
    sandboxesByStatus[statusKey] = (sandboxesByStatus[statusKey] ?? 0) + 1;
    const templateKey = sandbox.templateRef ?? "unmapped";
    sandboxesByTemplate[templateKey] = (sandboxesByTemplate[templateKey] ?? 0) + 1;
    const ageBucket = getAgeBucket(sandbox.ageSeconds);
    sandboxAgeBuckets[ageBucket] = (sandboxAgeBuckets[ageBucket] ?? 0) + 1;
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

  const templatesInUse = templates.filter(
    (template) => template.activeClaims > 0 || template.activeSandboxes > 0 || template.activeWarmPools > 0,
  ).length;

  return {
    totals: computeTotals(sandboxes, claims, warmPools, templatesInUse),
    phaseBreakdown: computePhaseBreakdown(sandboxes),
    pendingClaimsByReason: computePendingClaimsByReason(claims),
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
