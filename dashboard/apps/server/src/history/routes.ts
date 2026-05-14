import type { FastifyInstance } from "fastify";
import type { HistoryResolution } from "@agent-sandbox/dashboard-shared";
import type { HistoryStore } from "./history-store.js";

interface HistoryQuery {
  since?: string;
  until?: string;
  res?: HistoryResolution;
}

export function registerHistoryRoutes(app: FastifyInstance, store: HistoryStore) {
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
    return snapshot;
  });
}
