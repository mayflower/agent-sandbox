import { classifyProblems, normalizeAll } from "./normalizers.js";
import { computeLiveOverview } from "./overview.js";
import type {
  ClaimLiveView,
  ControllerHealth,
  InventorySnapshot,
  SandboxLiveView,
  SnapshotCost,
  SnapshotMetricsRow,
  WarmPoolLiveView,
} from "./types.js";

/** Discard sandboxes younger than this from cold-start p95 noise. */
export const STARTING_AGE_MIN_SECONDS = 5;
/** Claim age past which "pending" counts as a failed pod. */
export const PENDING_CLAIM_FAIL_SECONDS = 300;

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[rank] ?? 0;
}

/** A pod is failed when its sandbox is active-but-missing-runtime, or its
 *  claim is pending past PENDING_CLAIM_FAIL_SECONDS. Shared between the
 *  server-side metrics projection and the web KPI override. */
export function failedPods(claims: ClaimLiveView[], sandboxes: SandboxLiveView[]): number {
  const sbCount = sandboxes.filter(
    (sandbox) => sandbox.objectState === "active" && sandbox.runtimeState === "missing",
  ).length;
  const claimCount = claims.filter(
    (claim) => claim.state === "pending" && claim.ageSeconds > PENDING_CLAIM_FAIL_SECONDS,
  ).length;
  return sbCount + claimCount;
}

export function warmPoolFillRatio(pools: WarmPoolLiveView[]): number {
  const desired = pools.reduce((sum, pool) => sum + pool.desiredReplicas, 0);
  if (desired === 0) return 0;
  const ready = pools.reduce((sum, pool) => sum + pool.readyReplicas, 0);
  return ready / desired;
}

/** p95 of "starting" sandbox ages, with the same min-age cutoff as the
 *  server-side metrics projection. */
export function sandboxStartingP95(sandboxes: SandboxLiveView[]): number {
  return percentile(
    sandboxes
      .filter((s) => s.runtimeState === "starting" && s.ageSeconds >= STARTING_AGE_MIN_SECONDS)
      .map((s) => s.ageSeconds),
    95,
  );
}

export interface ProjectionInputs {
  snapshot: InventorySnapshot;
  now?: Date;
  /** Optional cost snapshot if cost.yaml is configured. */
  cost?: SnapshotCost | null;
  /** Optional controller health override (otherwise read from snapshot). */
  controllerHealth?: ControllerHealth | null;
}

export function projectSnapshotToMetricsRow(inputs: ProjectionInputs): SnapshotMetricsRow {
  const { snapshot, cost } = inputs;
  const now = inputs.now ?? new Date();
  const inventory = normalizeAll(snapshot, now);
  const overview = computeLiveOverview(inventory.sandboxes, inventory.claims, inventory.warmPools);
  const problems = classifyProblems(snapshot, now, inventory);

  const claimAges = inventory.claims.filter((c) => c.state === "pending").map((c) => c.ageSeconds);

  const controllerHealth = inputs.controllerHealth ?? snapshot.controllerHealth;
  const controllerAvailable: 0 | 1 = controllerHealth?.available ? 1 : 0;

  return {
    timestampMs: now.getTime(),
    totalSandboxes: overview.totals.totalSandboxes,
    activeSandboxes: overview.totals.activeSandboxes,
    runtimeReadySandboxes: overview.totals.runtimeReadySandboxes,
    runtimeMissingSandboxes: overview.totals.runtimeMissingSandboxes,
    pendingClaims: overview.totals.pendingClaims,
    claimsWithReadinessMismatch: overview.totals.claimsWithReadinessMismatch,
    warmPoolReadyTotal: overview.totals.warmPoolReadyTotal,
    warmPoolDesiredTotal: overview.totals.warmPoolDesiredTotal,
    templatesInUse: overview.totals.templatesInUse,
    unmappedSandboxes: overview.totals.unmappedSandboxes,
    problemErrors: problems.filter((p) => p.severity === "error").length,
    problemWarnings: problems.filter((p) => p.severity === "warning").length,
    claimAgeP50: percentile(claimAges, 50),
    claimAgeP95: percentile(claimAges, 95),
    sandboxStartingP95: sandboxStartingP95(inventory.sandboxes),
    warmPoolFillRatio: warmPoolFillRatio(inventory.warmPools),
    failedPods: failedPods(inventory.claims, inventory.sandboxes),
    controllerAvailable,
    costPerHourUsd: cost?.totalUsdPerHour ?? 0,
    idleSpendPerHourUsd: cost?.idleUsdPerHour ?? 0,
  };
}
