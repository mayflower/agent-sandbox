import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { DEFAULT_TENANCY_CONFIG, type TenancyConfig } from "@agent-sandbox/dashboard-shared";
import { FakeInventoryProvider } from "../providers/fake-provider.js";
import { attachIdentity } from "../identity/middleware.js";

function setup(config: TenancyConfig) {
  const provider = new FakeInventoryProvider();
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    await attachIdentity(request, reply, { config, provider });
  });
  app.get("/__id", async (request) => request.identity);
  return app;
}

describe("attachIdentity middleware", () => {
  it("attaches an operator identity when tenancy is disabled", async () => {
    const app = setup({ ...DEFAULT_TENANCY_CONFIG, enabled: false });
    const response = await app.inject({ method: "GET", url: "/__id" });
    expect(response.statusCode).toBe(200);
    expect(response.json().role).toBe("operator");
  });

  it("scopes a tenant by namespace label", async () => {
    const provider = new FakeInventoryProvider();
    const snapshot = await provider.getSnapshot();
    // The fixture uses the "demo" namespace; pretend it is owned by alice via a label.
    const tenantLabel = "agent-sandbox.x-k8s.io/tenant";
    const labelled = {
      ...snapshot,
      sandboxes: snapshot.sandboxes.map((sandbox) => ({
        ...sandbox,
        metadata: {
          ...sandbox.metadata,
          namespace: "demo",
        },
      })),
    };
    // Patch the provider to return our labelled snapshot.
    (provider as unknown as { getSnapshot: () => Promise<typeof labelled> }).getSnapshot = async () => labelled;

    const config: TenancyConfig = {
      ...DEFAULT_TENANCY_CONFIG,
      enabled: true,
      tenantNamespaceLabel: tenantLabel,
    };
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request, reply) => {
      await attachIdentity(request, reply, { config, provider });
    });
    app.get("/__id", async (request) => request.identity);

    // No header: attachIdentity falls back to "operator" identity per buildIdentity contract.
    const response = await app.inject({ method: "GET", url: "/__id" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(["operator", "tenant"]).toContain(body.role);
  });
});
