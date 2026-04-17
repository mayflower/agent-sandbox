import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { FakeInventoryProvider } from "../providers/fake-provider.js";

describe("dashboard server app", () => {
  afterEach(async () => {
    // no-op placeholder for consistency
  });

  it("serves healthz and capabilities for core-only mode", async () => {
    const app = buildApp({
      provider: new FakeInventoryProvider({
        capabilities: {
          claims: false,
          warmPools: false,
          templates: false,
        },
      }),
    });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const capabilities = await app.inject({ method: "GET", url: "/api/capabilities" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(capabilities.json()).toEqual({
      sandboxes: true,
      claims: false,
      warmPools: false,
      templates: false,
      events: true,
      controllerHealth: true,
    });

    await app.close();
  });

  it("serves normalized inventory routes and overview data", async () => {
    const app = buildApp({
      provider: new FakeInventoryProvider({ snapshot: createFixtureSnapshot() }),
    });

    const [overview, sandboxes, claims, warmPools, templates, problems, events] = await Promise.all([
      app.inject({ method: "GET", url: "/api/overview" }),
      app.inject({ method: "GET", url: "/api/sandboxes" }),
      app.inject({ method: "GET", url: "/api/claims" }),
      app.inject({ method: "GET", url: "/api/warm-pools" }),
      app.inject({ method: "GET", url: "/api/templates" }),
      app.inject({ method: "GET", url: "/api/problems" }),
      app.inject({
        method: "GET",
        url: "/api/events?namespace=demo&resourceKind=SandboxClaim&resourceName=mismatch-claim",
      }),
    ]);

    expect(overview.json().totals.claimsWithReadinessMismatch).toBe(1);
    expect(sandboxes.json().some((sandbox: { name: string; runtimeState: string }) => sandbox.name === "retained-sbx" && sandbox.runtimeState === "missing")).toBe(true);
    expect(claims.json().some((claim: { name: string; readinessMismatch: boolean }) => claim.name === "mismatch-claim" && claim.readinessMismatch)).toBe(true);
    expect(warmPools.json()[0]).toMatchObject({
      name: "fast-pool",
      desiredReplicas: 2,
      readyReplicas: 1,
    });
    expect(templates.json().some((template: { name: string; networkPolicyMode: string }) => template.name === "custom-net" && template.networkPolicyMode === "custom")).toBe(true);
    expect(problems.json().length).toBeGreaterThan(0);
    expect(events.json()).toHaveLength(1);

    const controllerHealth = await app.inject({ method: "GET", url: "/api/controller-health" });
    expect(controllerHealth.statusCode).toBe(200);
    expect(controllerHealth.json()).toMatchObject({ available: true, ready: 1, desired: 1 });

    await app.close();
  });
});
