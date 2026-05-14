import type {
  ClaimLiveView,
  InventorySnapshot,
  ResourceRef,
  SandboxLiveView,
  SandboxResourceKind,
  SnapshotDiff,
  WarmPoolLiveView,
} from "./types.js";
import { normalizeAll } from "./normalizers.js";

interface CapturedSnapshot {
  at: string;
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  warmPools: WarmPoolLiveView[];
}

function refKey(ref: ResourceRef): string {
  return `${ref.resourceKind}:${ref.namespace}/${ref.resourceName}`;
}

function toRef(
  kind: SandboxResourceKind,
  resource: { namespace: string; name: string },
): ResourceRef {
  return { resourceKind: kind, namespace: resource.namespace, resourceName: resource.name };
}

export function captureSnapshot(snapshot: InventorySnapshot, at: string, now = new Date()): CapturedSnapshot {
  const inventory = normalizeAll(snapshot, now);
  return {
    at,
    sandboxes: inventory.sandboxes,
    claims: inventory.claims,
    warmPools: inventory.warmPools,
  };
}

export function diffSnapshots(from: CapturedSnapshot, to: CapturedSnapshot): SnapshotDiff {
  const fromRefs = new Map<string, ResourceRef>();
  const toRefs = new Map<string, ResourceRef>();

  for (const sandbox of from.sandboxes) fromRefs.set(refKey(toRef("Sandbox", sandbox)), toRef("Sandbox", sandbox));
  for (const claim of from.claims) fromRefs.set(refKey(toRef("SandboxClaim", claim)), toRef("SandboxClaim", claim));
  for (const pool of from.warmPools)
    fromRefs.set(refKey(toRef("SandboxWarmPool", pool)), toRef("SandboxWarmPool", pool));

  for (const sandbox of to.sandboxes) toRefs.set(refKey(toRef("Sandbox", sandbox)), toRef("Sandbox", sandbox));
  for (const claim of to.claims) toRefs.set(refKey(toRef("SandboxClaim", claim)), toRef("SandboxClaim", claim));
  for (const pool of to.warmPools) toRefs.set(refKey(toRef("SandboxWarmPool", pool)), toRef("SandboxWarmPool", pool));

  const added: ResourceRef[] = [];
  const removed: ResourceRef[] = [];
  for (const [key, ref] of toRefs) if (!fromRefs.has(key)) added.push(ref);
  for (const [key, ref] of fromRefs) if (!toRefs.has(key)) removed.push(ref);

  const transitions: SnapshotDiff["transitions"] = [];
  const sandboxIndex = new Map<string, SandboxLiveView>();
  for (const sandbox of from.sandboxes) sandboxIndex.set(refKey(toRef("Sandbox", sandbox)), sandbox);
  for (const sandbox of to.sandboxes) {
    const key = refKey(toRef("Sandbox", sandbox));
    const previous = sandboxIndex.get(key);
    if (!previous) continue;
    if (previous.runtimeState !== sandbox.runtimeState) {
      transitions.push({
        ...toRef("Sandbox", sandbox),
        field: "runtimeState",
        from: previous.runtimeState,
        to: sandbox.runtimeState,
      });
    }
    if (previous.objectState !== sandbox.objectState) {
      transitions.push({
        ...toRef("Sandbox", sandbox),
        field: "objectState",
        from: previous.objectState,
        to: sandbox.objectState,
      });
    }
    if (previous.effectiveReady !== sandbox.effectiveReady) {
      transitions.push({
        ...toRef("Sandbox", sandbox),
        field: "effectiveReady",
        from: String(previous.effectiveReady),
        to: String(sandbox.effectiveReady),
      });
    }
  }

  const claimIndex = new Map<string, ClaimLiveView>();
  for (const claim of from.claims) claimIndex.set(refKey(toRef("SandboxClaim", claim)), claim);
  for (const claim of to.claims) {
    const key = refKey(toRef("SandboxClaim", claim));
    const previous = claimIndex.get(key);
    if (!previous) continue;
    if (previous.state !== claim.state) {
      transitions.push({
        ...toRef("SandboxClaim", claim),
        field: "state",
        from: previous.state,
        to: claim.state,
      });
    }
  }

  return { fromAt: from.at, toAt: to.at, added, removed, transitions };
}
