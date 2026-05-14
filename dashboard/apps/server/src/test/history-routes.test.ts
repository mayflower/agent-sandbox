import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";
import { HistoryStore } from "../history/history-store.js";
import { registerHistoryRoutes } from "../history/routes.js";

function setup() {
  const store = new HistoryStore();
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    request.identity = { user: "op", role: "operator", namespaces: [], groups: [] };
  });
  registerHistoryRoutes(app, store);
  return { app, store };
}

describe("history routes", () => {
  it("returns 400 when since/until are not parseable", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/history/metrics?since=garbage" });
    expect(response.statusCode).toBe(400);
  });

  it("returns the recorded series", async () => {
    const { app, store } = setup();
    store.record({ at: new Date("2026-04-15T10:00:00Z"), snapshot: createFixtureSnapshot() });
    const response = await app.inject({ method: "GET", url: "/api/history/metrics?res=15s" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rows).toHaveLength(1);
  });

  it("returns 400 when /snapshot lacks the at query parameter", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/history/snapshot" });
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 when no snapshot is within tolerance", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/history/snapshot?at=2026-04-15T10:00:00.000Z",
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the stored snapshot when present", async () => {
    const { app, store } = setup();
    const at = new Date("2026-04-15T10:00:00Z");
    store.record({ at, snapshot: createFixtureSnapshot() });
    const response = await app.inject({
      method: "GET",
      url: `/api/history/snapshot?at=${at.toISOString()}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sandboxes.length).toBeGreaterThan(0);
  });
});
