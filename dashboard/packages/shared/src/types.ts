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

export interface RawContainerSpec {
  name: string;
  image: string;
  ports?: RawContainerPort[];
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
    sandboxTemplateRef: { name: string };
    lifecycle?: {
      shutdownTime?: string;
      shutdownPolicy?: "Delete" | "DeleteForeground" | "Retain";
    };
    warmpool?: string;
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
  controllerHealth: ControllerHealth | null;
}

export interface InventoryProvider {
  getCapabilities(): Promise<Capabilities>;
  getSnapshot(): Promise<InventorySnapshot>;
  deleteSandbox?(namespace: string, name: string): Promise<void>;
  deleteClaim?(namespace: string, name: string): Promise<void>;
  reconcileSandbox?(namespace: string, name: string): Promise<void>;
}

export type SandboxResourceKind = "Sandbox" | "SandboxClaim" | "SandboxWarmPool" | "SandboxTemplate";

export interface ActionResult {
  kind: "Sandbox" | "SandboxClaim";
  namespace: string;
  name: string;
  action: "deleted" | "reconciled";
}

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

export interface EventView {
  namespace: string;
  resourceKind: string;
  resourceName: string;
  reason?: string;
  type?: string;
  message: string;
  eventTime?: string;
}
