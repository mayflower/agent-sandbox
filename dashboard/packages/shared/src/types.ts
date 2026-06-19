export interface RawOwnerReference {
  apiVersion?: string;
  kind?: string;
  name?: string;
  uid?: string;
  controller?: boolean;
}

export interface RawObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: RawOwnerReference[];
}

export interface RawCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface RawContainerPort {
  containerPort: number;
}

export interface RawResourceRequests {
  cpu?: string;
  memory?: string;
}

export interface RawContainerSpec {
  name: string;
  image: string;
  ports?: RawContainerPort[];
  resources?: {
    requests?: RawResourceRequests;
    limits?: RawResourceRequests;
  };
}

export interface RawPodTemplateSpec {
  automountServiceAccountToken?: boolean;
  nodeName?: string;
  containers: RawContainerSpec[];
}

export interface RawPodTemplate {
  metadata?: {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: RawPodTemplateSpec;
}

export interface RawSandbox {
  apiVersion?: string;
  kind?: "Sandbox";
  metadata: RawObjectMeta;
  spec: {
    podTemplate: RawPodTemplate;
    replicas?: number;
    shutdownTime?: string;
    shutdownPolicy?: "Delete" | "Retain";
    volumeClaimTemplates?: Array<{
      metadata?: { name?: string };
      spec?: {
        resources?: {
          requests?: { storage?: string };
        };
      };
    }>;
  };
  status?: {
    conditions?: RawCondition[];
    podIPs?: string[];
    replicas?: number;
    selector?: string;
    service?: string;
    serviceFQDN?: string;
  };
}

export interface RawSandboxClaim {
  apiVersion?: string;
  kind?: "SandboxClaim";
  metadata: RawObjectMeta;
  spec: {
    warmPoolRef: { name: string };
    lifecycle?: {
      shutdownTime?: string;
      shutdownPolicy?: "Delete" | "DeleteForeground" | "Retain";
    };
  };
  status?: {
    conditions?: RawCondition[];
    sandbox?: {
      name?: string;
      podIPs?: string[];
    };
  };
}

export interface RawSandboxWarmPool {
  apiVersion?: string;
  kind?: "SandboxWarmPool";
  metadata: RawObjectMeta;
  spec: {
    replicas: number;
    sandboxTemplateRef: { name: string };
    updateStrategy?: {
      type?: "Recreate" | "OnReplenish";
    };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    selector?: string;
  };
}

export interface RawSandboxTemplate {
  apiVersion?: string;
  kind?: "SandboxTemplate";
  metadata: RawObjectMeta;
  spec: {
    podTemplate: RawPodTemplate;
    networkPolicyManagement?: "Managed" | "Unmanaged";
    networkPolicy?: {
      ingress?: unknown[];
      egress?: unknown[];
    };
  };
}

export interface RawPod {
  apiVersion?: string;
  kind?: "Pod";
  metadata: RawObjectMeta;
  spec?: {
    nodeName?: string;
  };
  status?: {
    phase?: string;
    podIP?: string;
    podIPs?: Array<{ ip?: string }>;
    conditions?: RawCondition[];
  };
}

export interface RawService {
  apiVersion?: string;
  kind?: "Service";
  metadata: RawObjectMeta;
}

export interface RawPersistentVolumeClaim {
  apiVersion?: string;
  kind?: "PersistentVolumeClaim";
  metadata: RawObjectMeta;
}

export interface RawEvent {
  apiVersion?: string;
  kind?: "Event";
  metadata: RawObjectMeta;
  type?: string;
  reason?: string;
  note?: string;
  message?: string;
  eventTime?: string;
  regarding?: {
    kind?: string;
    name?: string;
    namespace?: string;
  };
  involvedObject?: {
    kind?: string;
    name?: string;
    namespace?: string;
  };
}

export interface Capabilities {
  sandboxes: true;
  claims: boolean;
  warmPools: boolean;
  templates: boolean;
  events: boolean;
  controllerHealth: boolean;
}

export interface ControllerHealth {
  available: boolean;
  ready: number;
  desired: number;
  reason?: string;
}

/** Minimal Namespace info needed to resolve tenant identity. Captured once
 *  per snapshot so the identity middleware doesn't re-list namespaces on
 *  every request. */
export interface RawNamespace {
  name: string;
  labels?: Record<string, string>;
}

export interface InventorySnapshot {
  capabilities: Capabilities;
  sandboxes: RawSandbox[];
  claims: RawSandboxClaim[];
  warmPools: RawSandboxWarmPool[];
  templates: RawSandboxTemplate[];
  pods: RawPod[];
  services: RawService[];
  pvcs: RawPersistentVolumeClaim[];
  events: RawEvent[];
  /** Optional: present when the provider can list namespaces with labels.
   *  Empty array means the call succeeded but found none; absent means the
   *  provider didn't attempt it (FakeProvider in tests, older snapshots). */
  namespaces?: RawNamespace[];
  controllerHealth: ControllerHealth | null;
}

export interface InventoryProvider {
  getCapabilities(): Promise<Capabilities>;
  getSnapshot(): Promise<InventorySnapshot>;
  deleteSandbox?(namespace: string, name: string): Promise<void>;
  deleteClaim?(namespace: string, name: string): Promise<void>;
  reconcileSandbox?(namespace: string, name: string): Promise<void>;
  setSandboxReplicas?(namespace: string, name: string, replicas: number): Promise<void>;
  patchClaimLifecycle?(
    namespace: string,
    name: string,
    lifecycle: { shutdownTime?: string },
  ): Promise<void>;
}

export type SandboxResourceKind = "Sandbox" | "SandboxClaim" | "SandboxWarmPool" | "SandboxTemplate";

export type InventoryView = "sandboxes" | "claims" | "warm-pools" | "templates";

export function viewForKind(kind: SandboxResourceKind): InventoryView {
  switch (kind) {
    case "Sandbox":
      return "sandboxes";
    case "SandboxClaim":
      return "claims";
    case "SandboxWarmPool":
      return "warm-pools";
    case "SandboxTemplate":
      return "templates";
  }
}

export type SandboxAction = "deleted" | "reconciled" | "paused" | "resumed";
export type SandboxClaimAction = "deleted" | "extended";

export type ActionResult =
  | { kind: "Sandbox"; namespace: string; name: string; action: SandboxAction }
  | { kind: "SandboxClaim"; namespace: string; name: string; action: "deleted" }
  | {
      kind: "SandboxClaim";
      namespace: string;
      name: string;
      action: "extended";
      shutdownTime: string;
    };

export interface StatDatum {
  label: string;
  value: number;
}

export interface WarmPoolBarDatum {
  label: string;
  ready: number;
  desired: number;
}

export type SandboxPhase =
  | "ready"
  | "starting"
  | "terminating"
  | "stopped"
  | "runtime-missing"
  | "retained"
  | "expired"
  | "deleting";

export interface PhaseDatum {
  phase: SandboxPhase;
  label: string;
  count: number;
}

/** Bundled response served by `/api/snapshot`. Lets the SPA replace ~9 parallel
 *  polls with a single round-trip; the server builds this from one scoped
 *  inventory fetch so it's strictly cheaper than the per-route calls it
 *  replaces. Per-view endpoints (/api/sandboxes, /api/claims, ...) stay for
 *  bookmarks and third-party scripts; the SPA prefers this. */
export interface DashboardSnapshot {
  /** ISO timestamp when this snapshot was assembled, for "Updated Xs ago". */
  updatedAt: string;
  identity: Identity;
  capabilities: Capabilities;
  controllerHealth: ControllerHealth | null;
  overview: OverviewSnapshot;
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  warmPools: WarmPoolLiveView[];
  templates: TemplateLiveView[];
  problems: ProblemView[];
  problemDag: ProblemDag;
  events: EventView[];
}

export interface OverviewSnapshot {
  totals: {
    totalSandboxes: number;
    activeSandboxes: number;
    runtimeReadySandboxes: number;
    runtimeMissingSandboxes: number;
    pendingClaims: number;
    claimsWithReadinessMismatch: number;
    warmPoolReadyTotal: number;
    warmPoolDesiredTotal: number;
    templatesInUse: number;
    unmappedSandboxes: number;
  };
  phaseBreakdown: PhaseDatum[];
  pendingClaimsByReason: PendingClaimReason[];
  charts: {
    sandboxesByStatus: StatDatum[];
    sandboxesByTemplate: StatDatum[];
    sandboxAgeBuckets: StatDatum[];
    sandboxShutdownBuckets: StatDatum[];
    claimsByState: StatDatum[];
    warmPoolDesiredVsReady: WarmPoolBarDatum[];
  };
}

export interface SandboxLiveView {
  namespace: string;
  name: string;
  ageSeconds: number;
  ownerKind: "direct" | "claim" | "warm-pool";
  ownerName?: string;
  templateRef?: string;
  claimName?: string;
  warmPoolName?: string;
  objectState: "active" | "expired" | "retained" | "deleting";
  runtimeState: "missing" | "starting" | "ready" | "stopped" | "terminating";
  effectiveReady: boolean;
  service?: string;
  serviceFQDN?: string;
  podIPs: string[];
  podName?: string;
  nodeName?: string;
  podPhase?: string;
  pvcNames: string[];
  shutdownTime?: string;
  shutdownPolicy?: "Delete" | "Retain";
}

export interface ClaimLiveView {
  namespace: string;
  name: string;
  ageSeconds: number;
  templateRef: string;
  warmPoolPolicy: "none" | "default" | string;
  sandboxName?: string;
  podIPs: string[];
  rawReadyCondition?: {
    status: "True" | "False" | "Unknown";
    reason?: string;
    message?: string;
  };
  effectiveReady: boolean;
  readinessMismatch: boolean;
  state: "pending" | "ready" | "expired" | "deleting" | "retained";
  shutdownTime?: string;
  shutdownPolicy?: "Delete" | "DeleteForeground" | "Retain";
}

export interface WarmPoolLiveView {
  namespace: string;
  name: string;
  templateRef: string;
  desiredReplicas: number;
  readyReplicas: number;
  creatingReplicas: number;
  failedReplicas: number;
  fillRatio: number;
  updateStrategy: "Recreate" | "OnReplenish";
  memberSandboxes: Array<{
    name: string;
    ready: boolean;
    podName?: string;
  }>;
}

export interface TemplateLiveView {
  namespace: string;
  name: string;
  images: string[];
  ports: number[];
  networkPolicyManagement: "Managed" | "Unmanaged";
  networkPolicyMode: "secure-default" | "custom" | "external";
  automountServiceAccountTokenDefaultFalse: boolean;
  activeClaims: number;
  activeSandboxes: number;
  activeWarmPools: number;
}

export type ProblemKind =
  | "retained-without-runtime"
  | "claim-runtime-mismatch"
  | "warm-pool-underfilled"
  | "unresolved-template-link"
  | "runtime-missing"
  | "sandbox-stuck-starting"
  | "sandbox-stuck-terminating"
  | "claim-stuck-pending";

export interface PendingClaimReason {
  reason: string;
  count: number;
  claims: Array<{ namespace: string; name: string }>;
}

export interface ProblemView {
  kind: ProblemKind;
  severity: "info" | "warning" | "error";
  namespace: string;
  resourceKind: SandboxResourceKind;
  resourceName: string;
  summary: string;
}

export interface ProblemGroup {
  kind: ProblemKind;
  severity: "info" | "warning" | "error";
  summary: string;
  count: number;
  items: ProblemView[];
}

/** Resource kinds that can appear on events/timeline entries. Includes the
 *  Sandbox CRD family plus the auxiliary kinds k8s emits about (Pod) and that
 *  the sandbox-router service emits about (Router). */
export type EventResourceKind = SandboxResourceKind | "Pod" | "Router";

export interface EventView {
  namespace: string;
  resourceKind: EventResourceKind;
  resourceName: string;
  reason?: string;
  type?: string;
  message: string;
  eventTime?: string;
}

// ----------------------------------------------------------------------------
// Foundation A: Server-side Ring-Buffer + History API (M1)
// ----------------------------------------------------------------------------

export type HistoryResolution = "15s" | "5m";

/** Skinny projection of a Snapshot — ~30 scalars used for sparklines + trend KPIs. */
export interface SnapshotMetricsRow {
  /** Epoch milliseconds. The ring-buffer key. */
  timestampMs: number;
  // Counts
  totalSandboxes: number;
  activeSandboxes: number;
  runtimeReadySandboxes: number;
  runtimeMissingSandboxes: number;
  pendingClaims: number;
  claimsWithReadinessMismatch: number;
  warmPoolReadyTotal: number;
  warmPoolDesiredTotal: number;
  templatesInUse: number;
  unmappedSandboxes: number;
  // Problem aggregates
  problemErrors: number;
  problemWarnings: number;
  // Latency/health (seconds)
  claimAgeP50: number;
  claimAgeP95: number;
  sandboxStartingP95: number;
  // Warm-pool aggregates
  warmPoolFillRatio: number;
  failedPods: number;
  // Controller
  controllerAvailable: 0 | 1;
  // Cost (optional — 0 when cost.yaml absent)
  costPerHourUsd: number;
  idleSpendPerHourUsd: number;
}

export const METRIC_KEYS = [
  "totalSandboxes",
  "activeSandboxes",
  "runtimeReadySandboxes",
  "runtimeMissingSandboxes",
  "pendingClaims",
  "claimsWithReadinessMismatch",
  "warmPoolReadyTotal",
  "warmPoolDesiredTotal",
  "templatesInUse",
  "unmappedSandboxes",
  "problemErrors",
  "problemWarnings",
  "claimAgeP50",
  "claimAgeP95",
  "sandboxStartingP95",
  "warmPoolFillRatio",
  "failedPods",
  "controllerAvailable",
  "costPerHourUsd",
  "idleSpendPerHourUsd",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

// Compile-time exhaustiveness check: if a key is added to SnapshotMetricsRow
// without being mirrored into METRIC_KEYS, this assignment fails to compile.
type _MetricKeysExhaustive =
  Exclude<keyof Omit<SnapshotMetricsRow, "timestampMs">, MetricKey> extends never ? true : never;
const _metricKeysExhaustive: _MetricKeysExhaustive = true;
void _metricKeysExhaustive;

export interface HistorySeries {
  resolution: HistoryResolution;
  rows: SnapshotMetricsRow[];
}

// ----------------------------------------------------------------------------
// Foundation D: Causality Resolver (M2)
// ----------------------------------------------------------------------------

/** Branded id for a problem aggregate so it cannot be mixed with arbitrary strings. */
export type ProblemId = string & { readonly __brand: "ProblemId" };

export interface ProblemNode {
  id: ProblemId;
  kind: ProblemKind;
  severity: "info" | "warning" | "error";
  summary: string;
  parentId?: ProblemId;
  affectedResources: Array<{
    namespace: string;
    resourceKind: SandboxResourceKind;
    resourceName: string;
  }>;
}

export interface ProblemDag {
  /** Root ids — likely root causes, no parent. */
  roots: ProblemId[];
  /** All nodes indexed by id. */
  byId: Record<ProblemId, ProblemNode>;
}

export interface ProblemDoc {
  kind: ProblemKind;
  title: string;
  /** 1-paragraph plain-language explanation. */
  explanation: string;
  /** First diagnostic checks the operator should run. */
  firstChecks: string[];
}

// ----------------------------------------------------------------------------
// M3: Timeline + Story
// ----------------------------------------------------------------------------

export type TimelineEventKind =
  | "pod"
  | "sandbox"
  | "claim"
  | "warmpool"
  | "transition"
  | "router";

export interface TimelineEvent {
  /** Stable id derived from source+resource+timestamp+reason. */
  id: string;
  kind: TimelineEventKind;
  /** ISO 8601 event time. */
  at: string;
  resourceKind: EventResourceKind;
  resourceName: string;
  namespace: string;
  /** Short reason code (e.g. PodScheduled, Ready=True). */
  reason: string;
  /** Operator-facing message. */
  message: string;
  /** Normalised severity. K8s `Normal` -> "info", `Warning` -> "warning"; "error" is reserved for synthesised transitions. */
  severity: "info" | "warning" | "error";
  /** Optional structured detail, free-form JSON. */
  detail?: Record<string, unknown>;
}

export interface StoryRow {
  at: string;
  verb: string;
  detail: string;
  severity: "info" | "warning" | "error";
  source: TimelineEvent;
}

// ----------------------------------------------------------------------------
// M4: Cost
// ----------------------------------------------------------------------------

export interface CostRates {
  cpuPerCoreHourUsd: number;
  memoryPerGibHourUsd: number;
  storagePerGibMonthUsd: number;
  /** Per-nodepool overrides keyed by nodeSelector match. */
  nodePoolOverrides: Array<{
    selector: Record<string, string>;
    cpuPerCoreHourUsd?: number;
    memoryPerGibHourUsd?: number;
  }>;
}

export interface CostBreakdown {
  cpuUsd: number;
  memoryUsd: number;
  storageUsd: number;
  totalUsd: number;
}

export interface PodCostInput {
  cpuCores: number;
  memoryGib: number;
  storageGib: number;
  uptimeHours: number;
  nodeLabels?: Record<string, string>;
}

export interface SnapshotCost {
  totalUsdPerHour: number;
  idleUsdPerHour: number;
  byKind: {
    sandboxesUsdPerHour: number;
    warmPoolsUsdPerHour: number;
  };
  rates: CostRates;
}

export interface CostRow {
  /** Grouping value, e.g. template name, namespace, or label value. */
  group: string;
  /** $/hour the running instances of this group are costing now. */
  usdPerHour: number;
  /** Subset of usdPerHour attributed to idle warm-pool members. */
  idleUsdPerHour: number;
  /** Per-instance count contributing to this row. */
  instanceCount: number;
}

export type CostGroupBy = "template" | "namespace" | `label:${string}`;

export interface CostByDimension {
  groupBy: CostGroupBy;
  rows: CostRow[];
}

// ----------------------------------------------------------------------------
// M5: Identity + Self-Service Actions
// ----------------------------------------------------------------------------

interface IdentityBase {
  user: string;
  groups: string[];
}

/** A scoped identity. `operator` sees every namespace; `tenant` is restricted to the listed ones. */
export type Identity =
  | (IdentityBase & { role: "operator"; namespaces: readonly [] })
  | (IdentityBase & { role: "tenant"; namespaces: string[] });

// ----------------------------------------------------------------------------
// M6: Diff
// ----------------------------------------------------------------------------

export interface ResourceRef {
  namespace: string;
  resourceKind: SandboxResourceKind;
  resourceName: string;
}

export interface SnapshotDiff {
  fromAt: string;
  toAt: string;
  added: ResourceRef[];
  removed: ResourceRef[];
  transitions: Array<
    ResourceRef & {
      field: string;
      from: string;
      to: string;
    }
  >;
}

// ----------------------------------------------------------------------------
// M8: Behavior
// ----------------------------------------------------------------------------

export interface SandboxBehavior {
  namespace: string;
  name: string;
  cpuMilliUsed?: number;
  cpuMilliRequested?: number;
  memoryMibUsed?: number;
  memoryMibRequested?: number;
  /** True if cpu usage > 2× template median (anomaly badge). */
  anomaly: boolean;
}

export interface TemplateBehavior {
  name: string;
  medianSessionSeconds?: number;
  p95ColdStartSeconds?: number;
  eventCountLast24h: number;
  failureCountLast24h: number;
}
