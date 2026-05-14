import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { FakeInventoryProvider } from "../providers/fake-provider.js";
import { registerActionRoutes } from "../actions/routes.js";

function buildAppForIdentity(identity: { user: string; role: "operator" | "tenant"; namespaces: string[] }) {
  const provider = new FakeInventoryProvider();
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    request.identity =
      identity.role === "operator"
        ? { user: identity.user, role: "operator", namespaces: [], groups: [] }
        : { user: identity.user, role: "tenant", namespaces: identity.namespaces, groups: [] };
  });
  registerActionRoutes(app, { provider });
  return { app, provider };
}

describe("action routes", () => {
  it("rejects a tenant pausing a sandbox outside their namespace scope", async () => {
    const { app } = buildAppForIdentity({ user: "alice", role: "tenant", namespaces: ["other"] });
    const response = await app.inject({
      method: "POST",
      url: "/api/actions/sandbox/demo/claim-ready/pause",
    });
    expect(response.statusCode).toBe(403);
  });

  it("allows operator pause and propagates to the provider", async () => {
    const { app, provider } = buildAppForIdentity({ user: "op", role: "operator", namespaces: [] });
    const response = await app.inject({
      method: "POST",
      url: "/api/actions/sandbox/demo/claim-ready/pause",
    });
    expect(response.statusCode).toBe(200);
    const snapshot = await provider.getSnapshot();
    const target = snapshot.sandboxes.find(
      (entry) => (entry.metadata.namespace ?? "default") === "demo" && entry.metadata.name === "claim-ready",
    );
    expect(target?.spec.replicas).toBe(0);
  });

  it("rejects seconds outside [1, 86400] on claim extend", async () => {
    const { app } = buildAppForIdentity({ user: "op", role: "operator", namespaces: [] });
    const low = await app.inject({ method: "POST", url: "/api/actions/claim/demo/quick-claim/extend?seconds=0" });
    expect(low.statusCode).toBe(400);
    const high = await app.inject({ method: "POST", url: "/api/actions/claim/demo/quick-claim/extend?seconds=86401" });
    expect(high.statusCode).toBe(400);
  });

  it("returns 501 when the provider lacks setSandboxReplicas", async () => {
    const provider = new FakeInventoryProvider();
    (provider as unknown as { setSandboxReplicas?: unknown }).setSandboxReplicas = undefined;
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request) => {
      request.identity = { user: "op", role: "operator", namespaces: [], groups: [] };
    });
    registerActionRoutes(app, { provider });
    const response = await app.inject({
      method: "POST",
      url: "/api/actions/sandbox/demo/claim-ready/pause",
    });
    expect(response.statusCode).toBe(501);
  });
});
