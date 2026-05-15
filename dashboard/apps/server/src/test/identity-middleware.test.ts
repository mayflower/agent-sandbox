import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  DEFAULT_TENANCY_CONFIG,
  type InventorySnapshot,
  type TenancyConfig,
} from "@agent-sandbox/dashboard-shared";
import { FakeInventoryProvider } from "../providers/fake-provider.js";
import { attachIdentity } from "../identity/middleware.js";

const TENANT_LABEL = "agent-sandbox.x-k8s.io/tenant";

function providerWithNamespaces(
  namespaces: Array<{ name: string; labels?: Record<string, string> }>,
) {
  const provider = new FakeInventoryProvider();
  const base = provider.getSnapshot();
  (provider as unknown as { getSnapshot: () => Promise<InventorySnapshot> }).getSnapshot = async () => ({
    ...(await base),
    namespaces,
  });
  return provider;
}

function buildApp(provider: FakeInventoryProvider, config: TenancyConfig) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    try {
      await attachIdentity(request, reply, { config, provider });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return reply.code(503).send({ message: detail });
    }
  });
  app.get("/__id", async (request) => request.identity);
  return app;
}

describe("attachIdentity middleware", () => {
  it("attaches an operator identity when tenancy is disabled", async () => {
    const provider = providerWithNamespaces([]);
    const app = buildApp(provider, { ...DEFAULT_TENANCY_CONFIG, enabled: false });
    const response = await app.inject({ method: "GET", url: "/__id" });
    expect(response.statusCode).toBe(200);
    expect(response.json().role).toBe("operator");
  });

  it("scopes a tenant to only the namespaces labelled with their user", async () => {
    const provider = providerWithNamespaces([
      { name: "alice-ns", labels: { [TENANT_LABEL]: "alice" } },
      { name: "bob-ns", labels: { [TENANT_LABEL]: "bob" } },
      { name: "shared", labels: {} },
    ]);
    const app = buildApp(provider, {
      ...DEFAULT_TENANCY_CONFIG,
      enabled: true,
      tenantNamespaceLabel: TENANT_LABEL,
    });
    const response = await app.inject({
      method: "GET",
      url: "/__id",
      headers: { "x-forwarded-user": "alice" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.role).toBe("tenant");
    expect(body.namespaces).toEqual(["alice-ns"]);
  });

  it("fails closed when tenancy is enabled but namespaces are unavailable", async () => {
    // Provider returns snapshot without `namespaces` — simulates 403 on
    // listing real Namespace objects. Must NOT silently fall back to an
    // empty-namespace tenant identity, which would leak nothing visibly but
    // also block every action.
    const provider = new FakeInventoryProvider();
    const app = buildApp(provider, {
      ...DEFAULT_TENANCY_CONFIG,
      enabled: true,
      tenantNamespaceLabel: TENANT_LABEL,
    });
    const response = await app.inject({
      method: "GET",
      url: "/__id",
      headers: { "x-forwarded-user": "alice" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toMatch(/namespace list/);
  });

  it("operator-group membership keeps the cluster-wide role", async () => {
    const provider = providerWithNamespaces([
      { name: "alice-ns", labels: { [TENANT_LABEL]: "alice" } },
    ]);
    const app = buildApp(provider, {
      ...DEFAULT_TENANCY_CONFIG,
      enabled: true,
      tenantNamespaceLabel: TENANT_LABEL,
    });
    const response = await app.inject({
      method: "GET",
      url: "/__id",
      headers: {
        "x-forwarded-user": "carol",
        "x-forwarded-groups": "sandbox-operators",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().role).toBe("operator");
  });
});
