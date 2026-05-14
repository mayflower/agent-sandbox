import type { FastifyReply, FastifyRequest } from "fastify";
import {
  buildIdentity,
  DEFAULT_TENANCY_CONFIG,
  type Identity,
  type InventoryProvider,
  type TenancyConfig,
} from "@agent-sandbox/dashboard-shared";

declare module "fastify" {
  interface FastifyRequest {
    identity: Identity;
  }
}

export interface IdentityDeps {
  config: TenancyConfig;
  provider: InventoryProvider;
}

export function loadTenancyConfig(env: NodeJS.ProcessEnv = process.env): TenancyConfig {
  return {
    enabled: env.DASHBOARD_TENANCY_ENABLED === "true",
    userHeader: env.DASHBOARD_USER_HEADER ?? DEFAULT_TENANCY_CONFIG.userHeader,
    tenantNamespaceLabel: env.DASHBOARD_TENANT_NAMESPACE_LABEL ?? DEFAULT_TENANCY_CONFIG.tenantNamespaceLabel,
    operatorGroups: env.DASHBOARD_OPERATOR_GROUPS
      ? env.DASHBOARD_OPERATOR_GROUPS.split(",").map((g) => g.trim()).filter(Boolean)
      : DEFAULT_TENANCY_CONFIG.operatorGroups,
    operatorGroupHeader: env.DASHBOARD_OPERATOR_GROUP_HEADER ?? DEFAULT_TENANCY_CONFIG.operatorGroupHeader,
  };
}

/** Decorate every request with `request.identity`. */
export async function attachIdentity(
  request: FastifyRequest,
  _reply: FastifyReply,
  deps: IdentityDeps,
): Promise<void> {
  const snapshot = await deps.provider.getSnapshot();
  const knownNamespaces = new Set<string>();
  for (const sandbox of snapshot.sandboxes) {
    if (sandbox.metadata.namespace) knownNamespaces.add(sandbox.metadata.namespace);
  }
  for (const claim of snapshot.claims) {
    if (claim.metadata.namespace) knownNamespaces.add(claim.metadata.namespace);
  }

  const namespaceList = [...knownNamespaces].map((name) => ({ name }));
  request.identity = buildIdentity(request.headers, deps.config, namespaceList);
}
