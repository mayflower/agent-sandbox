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

/** Decorate every request with `request.identity`. Throws when tenancy is
 *  enabled but the provider can't enumerate labeled Namespaces — that's a
 *  cross-tenant data-leak risk, so the caller (app.ts onRequest hook) maps
 *  the throw to 503 instead of silently downgrading the identity. */
export async function attachIdentity(
  request: FastifyRequest,
  _reply: FastifyReply,
  deps: IdentityDeps,
): Promise<void> {
  const snapshot = await deps.provider.getSnapshot();
  // Real Namespace objects carry the tenant-label selector. Without them
  // every tenant resolves to namespaces:[] and silently sees nothing.
  if (snapshot.namespaces === undefined) {
    throw new Error(
      "tenancy is enabled but provider returned no namespace list (missing RBAC list verb on Namespace?)",
    );
  }
  request.identity = buildIdentity(request.headers, deps.config, snapshot.namespaces);
}
