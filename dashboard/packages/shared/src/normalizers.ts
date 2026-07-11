import {
  findCondition,
  getAgeSeconds,
  getControllerOwner,
  getNamespace,
  getPodIPs,
  getPodName,
  getPodReady,
  getTemplateRefName,
  isExpired,
  resolveClaimTemplateName,
} from "./helpers.js";
import type {
  ClaimLiveView,
  InventorySnapshot,
  ProblemGroup,
  ProblemKind,
  ProblemView,
  RawPod,
  RawSandbox,
  SandboxLiveView,
  TemplateLiveView,
  WarmPoolLiveView,
} from "./types.js";

const GROUP_SUMMARIES: Record<ProblemKind, string> = {
  "runtime-missing": "Sandbox active but runtime pod missing",
  "retained-without-runtime": "Retained sandbox without running pod",
  "claim-runtime-mismatch": "Claim readiness disagrees with runtime",
  "warm-pool-underfilled": "Warm pool below desired capacity",
  "unresolved-template-link": "Resource references a missing template",
  "sandbox-stuck-starting": "Sandbox stuck starting",
  "sandbox-stuck-terminating": "Sandbox stuck terminating",
  "claim-stuck-pending": "Claim pending unusually long",
};

const STUCK_STARTING_SECONDS = 300;
const STUCK_TERMINATING_SECONDS = 300;
const STUCK_PENDING_SECONDS = 300;

const GROUP_SEVERITY_RANK: Record<ProblemGroup["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function groupProblems(problems: ProblemView[]): ProblemGroup[] {
  const map = new Map<ProblemKind, ProblemGroup>();

  for (const problem of problems) {
    const existing = map.get(problem.kind);
    if (existing) {
      existing.count += 1;
      existing.items.push(problem);
      if (GROUP_SEVERITY_RANK[problem.severity] < GROUP_SEVERITY_RANK[existing.severity]) {
        existing.severity = problem.severity;
      }
      continue;
    }

    map.set(problem.kind, {
      kind: problem.kind,
      severity: problem.severity,
      summary: GROUP_SUMMARIES[problem.kind] ?? problem.summary,
      count: 1,
      items: [problem],
    });
  }

  return [...map.values()].sort((left, right) => {
    const severityDelta = GROUP_SEVERITY_RANK[left.severity] - GROUP_SEVERITY_RANK[right.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return right.count - left.count;
  });
}

function withOptional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as Partial<Record<K, V>>;
}

function getSandboxObjectState(sandbox: RawSandbox, now: Date): SandboxLiveView["objectState"] {
  if (sandbox.metadata.deletionTimestamp) {
    return "deleting";
  }

  const readyCondition = findCondition(sandbox.status?.conditions, "Ready");
  const expired = isExpired(sandbox.spec.shutdownTime, now) || readyCondition?.reason === "SandboxExpired";

  if (expired) {
    return sandbox.spec.shutdownPolicy === "Retain" ? "retained" : "expired";
  }

  return "active";
}

function getSandboxRuntimeState(sandbox: RawSandbox, pod: RawPod | undefined, now: Date): SandboxLiveView["runtimeState"] {
  if (sandbox.metadata.deletionTimestamp || pod?.metadata.deletionTimestamp) {
    return "terminating";
  }

  const objectState = getSandboxObjectState(sandbox, now);
  if (!pod) {
    return "missing";
  }

  if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") {
    return "stopped";
  }

  if (getPodReady(pod)) {
    return "ready";
  }

  if (objectState === "retained" || objectState === "expired") {
    return "missing";
  }

  return "starting";
}

function getSandboxOwnership(sandbox: RawSandbox): Pick<SandboxLiveView, "ownerKind" | "ownerName" | "claimName" | "warmPoolName"> {
  const owner = getControllerOwner(sandbox.metadata.ownerReferences);

  if (!owner?.kind) {
    return {
      ownerKind: "direct",
    };
  }

  if (owner.kind === "SandboxClaim") {
    return {
      ownerKind: "claim",
      ...withOptional("ownerName", owner.name),
      ...withOptional("claimName", owner.name),
    };
  }

  if (owner.kind === "SandboxWarmPool") {
    return {
      ownerKind: "warm-pool",
      ...withOptional("ownerName", owner.name),
      ...withOptional("warmPoolName", owner.name),
    };
  }

  return {
    ownerKind: "direct",
  };
}

export function normalizeSandboxes(snapshot: InventorySnapshot, now = new Date()): SandboxLiveView[] {
  return snapshot.sandboxes
    .map((sandbox) => {
      const namespace = getNamespace(sandbox.metadata);
      const podName = getPodName(sandbox);
      const pod = snapshot.pods.find((candidate) => getNamespace(candidate.metadata) === namespace && candidate.metadata.name === podName);
      const pvcs = snapshot.pvcs
        .filter((pvc) =>
          getNamespace(pvc.metadata) === namespace &&
          pvc.metadata.ownerReferences?.some((owner) => owner.kind === "Sandbox" && owner.name === sandbox.metadata.name),
        )
        .map((pvc) => pvc.metadata.name);
      const objectState = getSandboxObjectState(sandbox, now);
      const runtimeState = getSandboxRuntimeState(sandbox, pod, now);
      const podIPs = getPodIPs(pod, sandbox);
      const ownership = getSandboxOwnership(sandbox);

      return {
        namespace,
        name: sandbox.metadata.name,
        ageSeconds: getAgeSeconds(sandbox.metadata.creationTimestamp, now),
        ...ownership,
        ...withOptional("templateRef", getTemplateRefName(sandbox, { claims: snapshot.claims, warmPools: snapshot.warmPools })),
        objectState,
        runtimeState,
        effectiveReady: objectState === "active" && runtimeState === "ready",
        ...withOptional("service", sandbox.status?.service),
        ...withOptional("serviceFQDN", sandbox.status?.serviceFQDN),
        podIPs,
        ...withOptional("podName", podName),
        ...withOptional("nodeName", pod?.spec?.nodeName),
        ...withOptional("podPhase", pod?.status?.phase),
        pvcNames: pvcs,
        ...withOptional("shutdownTime", sandbox.spec.shutdownTime),
        ...withOptional("shutdownPolicy", sandbox.spec.shutdownPolicy),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeClaims(
  snapshot: InventorySnapshot,
  now = new Date(),
  precomputed?: { sandboxes: SandboxLiveView[] },
): ClaimLiveView[] {
  const sandboxes = precomputed?.sandboxes ?? normalizeSandboxes(snapshot, now);

  return snapshot.claims
    .map((claim) => {
      const rawReady = findCondition(claim.status?.conditions, "Ready");
      const namespace = getNamespace(claim.metadata);
      const sandbox = sandboxes.find(
        (candidate) => candidate.namespace === namespace && candidate.name === claim.status?.sandbox?.name,
      );
      const shutdownTime = claim.spec.lifecycle?.shutdownTime;
      const shutdownPolicy = claim.spec.lifecycle?.shutdownPolicy;
      const expired = isExpired(shutdownTime, now);
      const state: ClaimLiveView["state"] =
        claim.metadata.deletionTimestamp
          ? "deleting"
          : expired
            ? shutdownPolicy === "Retain"
              ? "retained"
              : "expired"
            : sandbox?.effectiveReady
              ? "ready"
              : claim.status?.sandbox?.name
                ? "pending"
                : "pending";
      const effectiveReady = sandbox?.effectiveReady ?? false;
      const rawReadyTruthy = rawReady?.status === "True";

      return {
        namespace,
        name: claim.metadata.name,
        ageSeconds: getAgeSeconds(claim.metadata.creationTimestamp, now),
        ...withOptional("templateRef", resolveClaimTemplateName(claim, snapshot.warmPools)),
        ...withOptional("warmPoolName", claim.spec.warmPoolRef?.name),
        ...withOptional("sandboxName", claim.status?.sandbox?.name),
        podIPs: sandbox?.podIPs ?? claim.status?.sandbox?.podIPs ?? [],
        ...withOptional(
          "rawReadyCondition",
          rawReady
            ? {
                status: rawReady.status,
                ...withOptional("reason", rawReady.reason),
                ...withOptional("message", rawReady.message),
              }
            : undefined,
        ),
        effectiveReady,
        readinessMismatch: rawReadyTruthy !== effectiveReady,
        state,
        ...withOptional("shutdownTime", shutdownTime),
        ...withOptional("shutdownPolicy", shutdownPolicy),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeWarmPools(
  snapshot: InventorySnapshot,
  now = new Date(),
  precomputed?: { sandboxes: SandboxLiveView[] },
): WarmPoolLiveView[] {
  const sandboxes = precomputed?.sandboxes ?? normalizeSandboxes(snapshot, now);

  return snapshot.warmPools
    .map((warmPool) => {
      const namespace = getNamespace(warmPool.metadata);
      const members = sandboxes.filter(
        (sandbox) => sandbox.namespace === namespace && sandbox.warmPoolName === warmPool.metadata.name,
      );
      // v1beta1 makes spec.replicas optional with a server-side default of 1;
      // mirror that default here so a snapshot that omits it doesn't read as 0.
      const desiredReplicas = warmPool.spec.replicas ?? 1;
      const readyReplicas = warmPool.status?.readyReplicas ?? members.filter((member) => member.effectiveReady).length;
      const creatingReplicas = members.filter((member) => member.runtimeState === "starting").length;
      const failedReplicas = members.filter(
        (member) => member.runtimeState === "missing" || member.runtimeState === "stopped",
      ).length;
      return {
        namespace,
        name: warmPool.metadata.name,
        templateRef: warmPool.spec.sandboxTemplateRef.name,
        desiredReplicas,
        readyReplicas,
        creatingReplicas,
        failedReplicas,
        fillRatio: desiredReplicas > 0 ? readyReplicas / desiredReplicas : 0,
        updateStrategy: warmPool.spec.updateStrategy?.type ?? "OnReplenish",
        memberSandboxes: members.map((member) => ({
          name: member.name,
          ready: member.effectiveReady,
          ...withOptional("podName", member.podName),
        })),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeTemplates(
  snapshot: InventorySnapshot,
  now = new Date(),
  precomputed?: {
    sandboxes: SandboxLiveView[];
    claims: ClaimLiveView[];
    warmPools: WarmPoolLiveView[];
  },
): TemplateLiveView[] {
  const sandboxes = precomputed?.sandboxes ?? normalizeSandboxes(snapshot, now);
  const claims = precomputed?.claims ?? normalizeClaims(snapshot, now, { sandboxes });
  const warmPools = precomputed?.warmPools ?? normalizeWarmPools(snapshot, now, { sandboxes });

  const activeClaimsByTemplate = new Map<string, number>();
  for (const claim of claims) {
    if (claim.state === "expired" || !claim.templateRef) continue;
    const key = `${claim.namespace}/${claim.templateRef}`;
    activeClaimsByTemplate.set(key, (activeClaimsByTemplate.get(key) ?? 0) + 1);
  }
  const activeSandboxesByTemplate = new Map<string, number>();
  for (const sandbox of sandboxes) {
    if (!sandbox.templateRef || sandbox.objectState === "expired") continue;
    const key = `${sandbox.namespace}/${sandbox.templateRef}`;
    activeSandboxesByTemplate.set(key, (activeSandboxesByTemplate.get(key) ?? 0) + 1);
  }
  const warmPoolsByTemplate = new Map<string, number>();
  for (const pool of warmPools) {
    const key = `${pool.namespace}/${pool.templateRef}`;
    warmPoolsByTemplate.set(key, (warmPoolsByTemplate.get(key) ?? 0) + 1);
  }

  return snapshot.templates
    .map((template) => {
      const namespace = getNamespace(template.metadata);
      const key = `${namespace}/${template.metadata.name}`;
      const images = template.spec.podTemplate.spec.containers.map((container) => container.image);
      const ports = template.spec.podTemplate.spec.containers.flatMap((container) =>
        container.ports?.map((port) => port.containerPort) ?? [],
      );
      const networkPolicyManagement = template.spec.networkPolicyManagement ?? "Managed";
      const networkPolicyMode: TemplateLiveView["networkPolicyMode"] =
        networkPolicyManagement === "Unmanaged"
          ? "external"
          : template.spec.networkPolicy
            ? "custom"
            : "secure-default";

      return {
        namespace,
        name: template.metadata.name,
        images,
        ports,
        networkPolicyManagement,
        networkPolicyMode,
        automountServiceAccountTokenDefaultFalse:
          template.spec.podTemplate.spec.automountServiceAccountToken !== true,
        activeClaims: activeClaimsByTemplate.get(key) ?? 0,
        activeSandboxes: activeSandboxesByTemplate.get(key) ?? 0,
        activeWarmPools: warmPoolsByTemplate.get(key) ?? 0,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface NormalizedInventory {
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  warmPools: WarmPoolLiveView[];
  templates: TemplateLiveView[];
}

export function normalizeAll(snapshot: InventorySnapshot, now = new Date()): NormalizedInventory {
  const sandboxes = normalizeSandboxes(snapshot, now);
  const claims = normalizeClaims(snapshot, now, { sandboxes });
  const warmPools = normalizeWarmPools(snapshot, now, { sandboxes });
  const templates = normalizeTemplates(snapshot, now, { sandboxes, claims, warmPools });
  return { sandboxes, claims, warmPools, templates };
}

export function classifyProblems(
  snapshot: InventorySnapshot,
  now = new Date(),
  precomputed?: NormalizedInventory,
): ProblemView[] {
  const { sandboxes, claims, warmPools, templates: templateViews } = precomputed ?? normalizeAll(snapshot, now);
  const templates = new Set(templateViews.map((template) => `${template.namespace}/${template.name}`));
  const problems: ProblemView[] = [];

  for (const sandbox of sandboxes) {
    if (sandbox.objectState === "retained" && sandbox.runtimeState === "missing") {
      problems.push({
        kind: "retained-without-runtime",
        severity: "warning",
        namespace: sandbox.namespace,
        resourceKind: "Sandbox",
        resourceName: sandbox.name,
        summary: "Retained sandbox no longer has a running pod.",
      });
    } else if (sandbox.objectState === "active" && sandbox.runtimeState === "missing") {
      problems.push({
        kind: "runtime-missing",
        severity: "error",
        namespace: sandbox.namespace,
        resourceKind: "Sandbox",
        resourceName: sandbox.name,
        summary: "Sandbox is active but runtime resources are missing.",
      });
    }

    if (sandbox.templateRef && !templates.has(`${sandbox.namespace}/${sandbox.templateRef}`)) {
      problems.push({
        kind: "unresolved-template-link",
        severity: "warning",
        namespace: sandbox.namespace,
        resourceKind: "Sandbox",
        resourceName: sandbox.name,
        summary: "Sandbox references a template that is not present in the snapshot.",
      });
    }

    if (
      sandbox.objectState === "active" &&
      sandbox.runtimeState === "starting" &&
      sandbox.ageSeconds >= STUCK_STARTING_SECONDS
    ) {
      problems.push({
        kind: "sandbox-stuck-starting",
        severity: "warning",
        namespace: sandbox.namespace,
        resourceKind: "Sandbox",
        resourceName: sandbox.name,
        summary: `Sandbox has been starting for ${Math.round(sandbox.ageSeconds / 60)}m.`,
      });
    }

    if (sandbox.runtimeState === "terminating" && sandbox.ageSeconds >= STUCK_TERMINATING_SECONDS) {
      problems.push({
        kind: "sandbox-stuck-terminating",
        severity: "warning",
        namespace: sandbox.namespace,
        resourceKind: "Sandbox",
        resourceName: sandbox.name,
        summary: "Sandbox has been terminating for a long time.",
      });
    }
  }

  for (const claim of claims) {
    if (claim.readinessMismatch) {
      problems.push({
        kind: "claim-runtime-mismatch",
        severity: "warning",
        namespace: claim.namespace,
        resourceKind: "SandboxClaim",
        resourceName: claim.name,
        summary: "Claim readiness does not match effective runtime readiness.",
      });
    }

    if (claim.templateRef && !templates.has(`${claim.namespace}/${claim.templateRef}`)) {
      problems.push({
        kind: "unresolved-template-link",
        severity: "warning",
        namespace: claim.namespace,
        resourceKind: "SandboxClaim",
        resourceName: claim.name,
        summary: "Claim references a template that is not present in the snapshot.",
      });
    }

    if (claim.state === "pending" && claim.ageSeconds >= STUCK_PENDING_SECONDS) {
      const reason = claim.rawReadyCondition?.reason;
      problems.push({
        kind: "claim-stuck-pending",
        severity: "warning",
        namespace: claim.namespace,
        resourceKind: "SandboxClaim",
        resourceName: claim.name,
        summary: reason
          ? `Claim pending for ${Math.round(claim.ageSeconds / 60)}m (reason: ${reason}).`
          : `Claim pending for ${Math.round(claim.ageSeconds / 60)}m.`,
      });
    }
  }

  for (const warmPool of warmPools) {
    if (warmPool.readyReplicas < warmPool.desiredReplicas) {
      problems.push({
        kind: "warm-pool-underfilled",
        severity: "warning",
        namespace: warmPool.namespace,
        resourceKind: "SandboxWarmPool",
        resourceName: warmPool.name,
        summary: "Warm pool ready replicas are below the desired capacity.",
      });
    }

    if (!templates.has(`${warmPool.namespace}/${warmPool.templateRef}`)) {
      problems.push({
        kind: "unresolved-template-link",
        severity: "warning",
        namespace: warmPool.namespace,
        resourceKind: "SandboxWarmPool",
        resourceName: warmPool.name,
        summary: "Warm pool references a template that is not present in the snapshot.",
      });
    }
  }

  return problems;
}
