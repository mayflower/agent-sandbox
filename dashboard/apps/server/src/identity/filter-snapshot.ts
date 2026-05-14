import type { Identity, InventorySnapshot } from "@agent-sandbox/dashboard-shared";

/** Return a snapshot scoped to the namespaces visible to the identity.
 *  An operator (role === "operator") sees everything. */
export function filterSnapshotForIdentity(
  snapshot: InventorySnapshot,
  identity: Identity,
): InventorySnapshot {
  if (identity.role === "operator") return snapshot;
  const allowed = new Set(identity.namespaces);
  function pass<T extends { metadata: { namespace?: string } }>(items: T[]): T[] {
    return items.filter((item) => allowed.has(item.metadata.namespace ?? "default"));
  }
  return {
    ...snapshot,
    sandboxes: pass(snapshot.sandboxes),
    claims: pass(snapshot.claims),
    warmPools: pass(snapshot.warmPools),
    templates: pass(snapshot.templates),
    pods: pass(snapshot.pods),
    pvcs: pass(snapshot.pvcs),
    services: pass(snapshot.services),
    events: pass(snapshot.events),
  };
}
