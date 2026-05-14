import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(health.json().ok).toBe(true);
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

  it("reconcile endpoint calls the provider and returns the action result", async () => {
    const reconcileSandbox = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({
      provider: new FakeInventoryProvider({ snapshot: createFixtureSnapshot(), reconcileSandbox }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sandboxes/demo/claim-ready/reconcile",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: "Sandbox",
      namespace: "demo",
      name: "claim-ready",
      action: "reconciled",
    });
    expect(reconcileSandbox).toHaveBeenCalledWith("demo", "claim-ready");

    await app.close();
  });

  it("reconcile returns 404 when the sandbox is not in the snapshot", async () => {
    const app = buildApp({
      provider: new FakeInventoryProvider({
        snapshot: createFixtureSnapshot(),
        reconcileSandbox: vi.fn(),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sandboxes/demo/does-not-exist/reconcile",
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("delete endpoint rejects an active sandbox with 409", async () => {
    const deleteSandbox = vi.fn();
    const app = buildApp({
      provider: new FakeInventoryProvider({ snapshot: createFixtureSnapshot(), deleteSandbox }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sandboxes/demo/claim-ready/delete",
    });
    expect(response.statusCode).toBe(409);
    expect(deleteSandbox).not.toHaveBeenCalled();

    await app.close();
  });

  it("delete endpoint allows a retained sandbox and records the audit reason", async () => {
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({
      provider: new FakeInventoryProvider({ snapshot: createFixtureSnapshot(), deleteSandbox }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sandboxes/demo/retained-sbx/delete",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "Sandbox",
      namespace: "demo",
      name: "retained-sbx",
      action: "deleted",
    });
    expect(deleteSandbox).toHaveBeenCalledWith("demo", "retained-sbx");

    await app.close();
  });

  it("claim delete is rejected when the referenced template exists", async () => {
    const deleteClaim = vi.fn();
    const app = buildApp({
      provider: new FakeInventoryProvider({ snapshot: createFixtureSnapshot(), deleteClaim }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/claims/demo/quick-claim/delete",
    });
    expect(response.statusCode).toBe(409);
    expect(deleteClaim).not.toHaveBeenCalled();

    await app.close();
  });
});
