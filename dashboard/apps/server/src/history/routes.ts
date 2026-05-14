import type { FastifyInstance } from "fastify";
import {
  filterSnapshotForIdentity,
  type HistoryResolution,
} from "@agent-sandbox/dashboard-shared";
import type { HistoryStore } from "./history-store.js";

interface HistoryQuery {
  since?: string;
  until?: string;
  res?: HistoryResolution;
}

export function registerHistoryRoutes(app: FastifyInstance, store: HistoryStore) {
  // Aggregate counters in /api/history/metrics are scalar-only and contain no
  // per-namespace info, so operators and tenants see the same series. (The
  // operator view of "active sandboxes" is still useful capacity context.)
  app.get<{ Querystring: HistoryQuery }>("/api/history/metrics", async (request, reply) => {
    const resolution = request.query.res === "5m" ? "5m" : "15s";
    const since = request.query.since ? Date.parse(request.query.since) : undefined;
    const until = request.query.until ? Date.parse(request.query.until) : undefined;
    if ((request.query.since && Number.isNaN(since)) || (request.query.until && Number.isNaN(until))) {
      return reply.code(400).send({ message: "since/until must be ISO 8601 dates" });
    }
    return store.series(resolution, since, until);
  });

  app.get<{ Querystring: { at?: string } }>("/api/history/snapshot", async (request, reply) => {
    if (!request.query.at) {
      return reply.code(400).send({ message: "at query parameter required" });
    }
    const at = Date.parse(request.query.at);
    if (Number.isNaN(at)) {
      return reply.code(400).send({ message: "at must be ISO 8601" });
    }
    const snapshot = store.snapshotAt(at);
    if (!snapshot) {
      return reply.code(404).send({ message: "no snapshot within tolerance" });
    }
    // Scope to the caller's namespaces so a tenant cannot scrub into other
    // tenants' historical state.
    return filterSnapshotForIdentity(snapshot, request.identity);
  });
}
