import type {
  RawCondition,
  RawEvent,
  RawObjectMeta,
  RawOwnerReference,
  RawPod,
  RawSandbox,
  RawSandboxClaim,
  RawSandboxWarmPool,
  RawService,
} from "./types.js";

export const SANDBOX_POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";
export const SANDBOX_TEMPLATE_REF_ANNOTATION = "agents.x-k8s.io/sandbox-template-ref";
export const CLAIM_UID_LABEL = "agents.x-k8s.io/claim-uid";

export function getNamespace(metadata: RawObjectMeta): string {
  return metadata.namespace ?? "default";
}

export function getAgeSeconds(timestamp: string | undefined, now: Date): number {
  if (!timestamp) {
    return 0;
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return 0;
  }

  return Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
}

export function findCondition(conditions: RawCondition[] | undefined, type: string): RawCondition | undefined {
  return conditions?.find((condition) => condition.type === type);
}

export function isConditionTrue(conditions: RawCondition[] | undefined, type: string): boolean {
  return findCondition(conditions, type)?.status === "True";
}

export function getControllerOwner(ownerReferences: RawOwnerReference[] | undefined): RawOwnerReference | undefined {
  return ownerReferences?.find((owner) => owner.controller === true);
}

export function getPodName(sandbox: RawSandbox): string {
  return sandbox.metadata.annotations?.[SANDBOX_POD_NAME_ANNOTATION] ?? sandbox.metadata.name;
}

/** Resolve the template a claim ultimately uses. As of v1beta1 a claim no
 *  longer references a template directly; it references a SandboxWarmPool
 *  (`warmPoolRef`) and the pool carries the `sandboxTemplateRef`. So the
 *  template is reached transitively through the matching warm pool in the
 *  same namespace. Returns undefined when the claim has no warmPoolRef or the
 *  referenced pool isn't in the snapshot. */
export function resolveClaimTemplateName(
  claim: RawSandboxClaim,
  warmPools: RawSandboxWarmPool[],
): string | undefined {
  const warmPoolRef = claim.spec.warmPoolRef?.name;
  if (!warmPoolRef) {
    return undefined;
  }

  const namespace = getNamespace(claim.metadata);
  const pool = warmPools.find(
    (candidate) => getNamespace(candidate.metadata) === namespace && candidate.metadata.name === warmPoolRef,
  );
  return pool?.spec.sandboxTemplateRef.name;
}

export function getTemplateRefName(
  sandbox: RawSandbox,
  owners?: { claims: RawSandboxClaim[]; warmPools: RawSandboxWarmPool[] },
): string | undefined {
  const controller = getControllerOwner(sandbox.metadata.ownerReferences);

  if (owners && controller?.name && (controller.kind === "SandboxClaim" || controller.kind === "SandboxWarmPool")) {
    const namespace = getNamespace(sandbox.metadata);
    if (controller.kind === "SandboxClaim") {
      const claim = owners.claims.find(
        (candidate) => getNamespace(candidate.metadata) === namespace && candidate.metadata.name === controller.name,
      );
      return claim ? resolveClaimTemplateName(claim, owners.warmPools) : undefined;
    }
    const warmPool = owners.warmPools.find(
      (candidate) => getNamespace(candidate.metadata) === namespace && candidate.metadata.name === controller.name,
    );
    return warmPool?.spec.sandboxTemplateRef.name || undefined;
  }

  return sandbox.metadata.annotations?.[SANDBOX_TEMPLATE_REF_ANNOTATION];
}

export function getPodIPs(pod: RawPod | undefined, sandbox: RawSandbox): string[] {
  const statusIps = pod?.status?.podIPs?.map((entry) => entry.ip).filter(Boolean) as string[] | undefined;

  if (statusIps && statusIps.length > 0) {
    return statusIps;
  }

  if (pod?.status?.podIP) {
    return [pod.status.podIP];
  }

  return sandbox.status?.podIPs ?? [];
}

export function getPodReady(pod: RawPod | undefined): boolean {
  return isConditionTrue(pod?.status?.conditions, "Ready");
}

export function isExpired(shutdownTime: string | undefined, now: Date): boolean {
  if (!shutdownTime) {
    return false;
  }

  const parsed = Date.parse(shutdownTime);
  if (Number.isNaN(parsed)) {
    return false;
  }

  return parsed <= now.getTime();
}

export function getServiceForSandbox(services: RawService[], sandbox: RawSandbox): RawService | undefined {
  const namespace = getNamespace(sandbox.metadata);

  return services.find(
    (service) =>
      getNamespace(service.metadata) === namespace &&
      service.metadata.name === (sandbox.status?.service ?? sandbox.metadata.name),
  );
}

export function getEventTarget(event: RawEvent): { kind?: string; name?: string; namespace?: string } {
  return event.regarding ?? event.involvedObject ?? {};
}

export function compareByTimestampAsc(a: { creationTimestamp?: string }, b: { creationTimestamp?: string }): number {
  return Date.parse(a.creationTimestamp ?? "1970-01-01T00:00:00Z") - Date.parse(b.creationTimestamp ?? "1970-01-01T00:00:00Z");
}
