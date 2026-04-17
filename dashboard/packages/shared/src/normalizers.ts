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
} from "./helpers.js";
import type {
  ClaimLiveView,
  InventorySnapshot,
  ProblemView,
  RawPod,
  RawSandbox,
  SandboxLiveView,
  TemplateLiveView,
  WarmPoolLiveView,
  ClaimLiveView as ClaimView,
} from "./types.js";

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
        ...withOptional("templateRef", getTemplateRefName(sandbox)),
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

export function normalizeClaims(snapshot: InventorySnapshot, now = new Date()): ClaimLiveView[] {
  const sandboxes = normalizeSandboxes(snapshot, now);

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
      const state: ClaimView["state"] =
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
        templateRef: claim.spec.sandboxTemplateRef.name,
        warmPoolPolicy: claim.spec.warmpool ?? "default",
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

export function normalizeWarmPools(snapshot: InventorySnapshot, now = new Date()): WarmPoolLiveView[] {
  const sandboxes = normalizeSandboxes(snapshot, now);

  return snapshot.warmPools
    .map((warmPool) => {
      const namespace = getNamespace(warmPool.metadata);
      const members = sandboxes.filter(
        (sandbox) => sandbox.namespace === namespace && sandbox.warmPoolName === warmPool.metadata.name,
      );
      const desiredReplicas = warmPool.spec.replicas;
      const readyReplicas = warmPool.status?.readyReplicas ?? members.filter((member) => member.effectiveReady).length;
      return {
        namespace,
        name: warmPool.metadata.name,
        templateRef: warmPool.spec.sandboxTemplateRef.name,
        desiredReplicas,
        readyReplicas,
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

export function normalizeTemplates(snapshot: InventorySnapshot, now = new Date()): TemplateLiveView[] {
  const sandboxes = normalizeSandboxes(snapshot, now);
  const claims = normalizeClaims(snapshot, now);
  const warmPools = normalizeWarmPools(snapshot, now);

  return snapshot.templates
    .map((template) => {
      const namespace = getNamespace(template.metadata);
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
        activeClaims: claims.filter(
          (claim) => claim.namespace === namespace && claim.templateRef === template.metadata.name && claim.state !== "expired",
        ).length,
        activeSandboxes: sandboxes.filter(
          (sandbox) => sandbox.namespace === namespace && sandbox.templateRef === template.metadata.name && sandbox.objectState !== "expired",
        ).length,
        activeWarmPools: warmPools.filter(
          (warmPool) => warmPool.namespace === namespace && warmPool.templateRef === template.metadata.name,
        ).length,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function classifyProblems(snapshot: InventorySnapshot, now = new Date()): ProblemView[] {
  const sandboxes = normalizeSandboxes(snapshot, now);
  const claims = normalizeClaims(snapshot, now);
  const warmPools = normalizeWarmPools(snapshot, now);
  const templates = new Set(normalizeTemplates(snapshot, now).map((template) => `${template.namespace}/${template.name}`));
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

    if (!templates.has(`${claim.namespace}/${claim.templateRef}`)) {
      problems.push({
        kind: "unresolved-template-link",
        severity: "warning",
        namespace: claim.namespace,
        resourceKind: "SandboxClaim",
        resourceName: claim.name,
        summary: "Claim references a template that is not present in the snapshot.",
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
