import type { Identity, InventorySnapshot } from "./types.js";

export interface TenancyConfig {
  enabled: boolean;
  userHeader: string;
  tenantNamespaceLabel: string;
  operatorGroups: string[];
  operatorGroupHeader: string;
}

export const DEFAULT_TENANCY_CONFIG: TenancyConfig = {
  enabled: false,
  userHeader: "x-forwarded-user",
  tenantNamespaceLabel: "agent-sandbox.x-k8s.io/tenant",
  operatorGroups: ["sandbox-operators"],
  operatorGroupHeader: "x-forwarded-groups",
};

export function buildIdentity(
  headers: Record<string, string | string[] | undefined>,
  config: TenancyConfig,
  knownNamespaces: Array<{ name: string; labels?: Record<string, string> }>,
): Identity {
  function pickHeader(name: string): string | undefined {
    const value = headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  const userValue = pickHeader(config.userHeader)?.trim();
  const groupValue = pickHeader(config.operatorGroupHeader)?.trim();

  if (!config.enabled || !userValue) {
    return {
      user: userValue ?? "operator",
      role: "operator",
      namespaces: [],
      groups: groupValue ? groupValue.split(",").map((entry) => entry.trim()) : [],
    };
  }

  const groups = groupValue ? groupValue.split(",").map((entry) => entry.trim()) : [];
  const isOperator = config.operatorGroups.some((group) => groups.includes(group));

  if (isOperator) {
    return { user: userValue, role: "operator", namespaces: [], groups };
  }

  const visibleNamespaces = knownNamespaces
    .filter((ns) => ns.labels?.[config.tenantNamespaceLabel] === userValue)
    .map((ns) => ns.name);

  return {
    user: userValue,
    role: "tenant",
    namespaces: visibleNamespaces,
    groups,
  };
}

/** Return a snapshot scoped to the namespaces visible to the identity.
 *  An operator sees everything; a tenant only namespaces in `identity.namespaces`. */
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
