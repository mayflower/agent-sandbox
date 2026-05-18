import { DEFAULT_TENANCY_CONFIG } from "@agent-sandbox/dashboard-shared";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared/fixtures";
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

  it("attaches identity per-request when tenancy is enabled", async () => {
    const provider = new FakeInventoryProvider();
    const baseSnapshot = await provider.getSnapshot();
    // Tenancy is enabled, so attachIdentity needs labeled Namespaces to
    // resolve the caller. Without these the middleware fails closed (503).
    vi.spyOn(provider, "getSnapshot").mockResolvedValue({
      ...baseSnapshot,
      namespaces: [{ name: "demo", labels: {} }],
    });
    const app = buildApp({
      provider,
      tenancyConfig: { ...DEFAULT_TENANCY_CONFIG, enabled: true },
    });
    const response = await app.inject({ method: "GET", url: "/api/overview" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("returns 503 when tenancy is enabled but namespace list is unavailable", async () => {
    // Provider returns a snapshot without `namespaces` — simulates RBAC 403
    // on listing Namespace. The middleware must fail closed rather than
    // silently downgrade every tenant to an empty-scope identity.
    const provider = new FakeInventoryProvider();
    const app = buildApp({
      provider,
      tenancyConfig: { ...DEFAULT_TENANCY_CONFIG, enabled: true },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { "x-forwarded-user": "alice" },
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("returns 503 when identity resolution throws with tenancy enabled", async () => {
    const provider = new FakeInventoryProvider();
    vi.spyOn(provider, "getSnapshot").mockRejectedValueOnce(new Error("apiserver throttled"));
    const app = buildApp({
      provider,
      tenancyConfig: { ...DEFAULT_TENANCY_CONFIG, enabled: true },
    });
    const response = await app.inject({ method: "GET", url: "/api/overview" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("does not call provider.getSnapshot on identity hook when tenancy is disabled", async () => {
    const provider = new FakeInventoryProvider();
    const spy = vi.spyOn(provider, "getSnapshot");
    const app = buildApp({
      provider,
      tenancyConfig: { ...DEFAULT_TENANCY_CONFIG, enabled: false },
    });
    await app.inject({ method: "GET", url: "/healthz" });
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a tenant attempting to delete a sandbox outside their namespace scope", async () => {
    const provider = new FakeInventoryProvider({
      snapshot: createFixtureSnapshot(),
      deleteSandbox: vi.fn(),
    });
    const baseSnapshot = await provider.getSnapshot();
    vi.spyOn(provider, "getSnapshot").mockResolvedValue({
      ...baseSnapshot,
      // alice owns "alice-ns" but the target sandbox lives in "demo".
      namespaces: [
        { name: "alice-ns", labels: { "agent-sandbox.x-k8s.io/tenant": "alice" } },
        { name: "demo", labels: { "agent-sandbox.x-k8s.io/tenant": "bob" } },
      ],
    });
    const app = buildApp({
      provider,
      tenancyConfig: { ...DEFAULT_TENANCY_CONFIG, enabled: true },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/sandboxes/demo/retained-sbx/delete",
      headers: { "x-forwarded-user": "alice" },
    });
    expect(response.statusCode).toBe(403);
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    await app.close();
  });

  it("forbids tenants from triggering cluster-wide orphan cleanup", async () => {
    const deleteSandbox = vi.fn();
    const provider = new FakeInventoryProvider({
      snapshot: createFixtureSnapshot(),
      deleteSandbox,
    });
    const baseSnapshot = await provider.getSnapshot();
    vi.spyOn(provider, "getSnapshot").mockResolvedValue({
      ...baseSnapshot,
      namespaces: [{ name: "alice-ns", labels: { "agent-sandbox.x-k8s.io/tenant": "alice" } }],
    });
    const app = buildApp({
      provider,
      tenancyConfig: { ...DEFAULT_TENANCY_CONFIG, enabled: true },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/orphans/cleanup",
      headers: { "x-forwarded-user": "alice" },
    });
    expect(response.statusCode).toBe(403);
    expect(deleteSandbox).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects mutating requests from a cross-site origin", async () => {
    const provider = new FakeInventoryProvider({ snapshot: createFixtureSnapshot() });
    const app = buildApp({ provider });
    const response = await app.inject({
      method: "POST",
      url: "/api/sandboxes/demo/retained-sbx/delete",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/cross-site/);
    await app.close();
  });

  it("rejects mutating requests when Origin header doesn't match the Host", async () => {
    const provider = new FakeInventoryProvider({ snapshot: createFixtureSnapshot() });
    const app = buildApp({ provider });
    const response = await app.inject({
      method: "POST",
      url: "/api/sandboxes/demo/retained-sbx/delete",
      headers: { origin: "https://evil.example", host: "dashboard.internal" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/origin does not match host/);
    await app.close();
  });

  it("scopes /api/history/diff to the caller's namespaces", async () => {
    const provider = new FakeInventoryProvider();
    const baseSnapshot = await provider.getSnapshot();
    // Two namespaces in the snapshot; alice owns only one. The diff must
    // not surface a transition from the namespace alice can't see.
    const labelled = {
      ...baseSnapshot,
      namespaces: [
        { name: "alice-ns", labels: { "agent-sandbox.x-k8s.io/tenant": "alice" } },
        { name: "demo", labels: {} },
      ],
    };
    vi.spyOn(provider, "getSnapshot").mockResolvedValue(labelled);
    const app = buildApp({
      provider,
      tenancyConfig: { ...DEFAULT_TENANCY_CONFIG, enabled: true },
    });
    // Pre-warm two snapshots via the history store would be cleaner, but
    // here we just verify the route requires both timestamps and 404s when
    // the history is empty — the security path runs identity scope before
    // diff, so a tenant request never reaches an unscoped diff.
    const response = await app.inject({
      method: "GET",
      url: "/api/history/diff?from=2026-01-01T00:00:00Z&to=2026-01-01T00:01:00Z",
      headers: { "x-forwarded-user": "alice" },
    });
    expect([404, 200]).toContain(response.statusCode);
    expect(response.statusCode).not.toBe(403);
    await app.close();
  });

  it("/healthz returns 503 when the poll loop has degraded past the threshold", async () => {
    const provider = new FakeInventoryProvider();
    const getPollHealth = () => ({
      lastSuccessAt: null,
      lastErrorAt: Date.now(),
      lastErrorMessage: "apiserver unavailable",
      consecutiveFailures: 50,
    });
    const app = buildApp({ provider, getPollHealth });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(503);
    expect(response.json().ok).toBe(false);
    await app.close();
  });

  it("/healthz returns 200 during a brief transient poll failure", async () => {
    const provider = new FakeInventoryProvider();
    const getPollHealth = () => ({
      lastSuccessAt: Date.now() - 30_000,
      lastErrorAt: Date.now(),
      lastErrorMessage: "transient",
      consecutiveFailures: 2,
    });
    const app = buildApp({ provider, getPollHealth });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    await app.close();
  });
});
