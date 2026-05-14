import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  buildCostByDimension,
  buildSnapshotCost,
  type CostGroupBy,
  type CostRates,
  type InventorySnapshot,
} from "@agent-sandbox/dashboard-shared";

function parseGroupBy(raw: string): CostGroupBy | null {
  if (raw === "template" || raw === "namespace") return raw;
  if (raw.startsWith("label:") && raw.length > "label:".length) return raw as `label:${string}`;
  return null;
}

export interface CostRoutesDeps {
  /** Returns a tenant-scoped snapshot for the given request. */
  scopedSnapshot(request: FastifyRequest): Promise<InventorySnapshot>;
  getRates(): CostRates | null;
}

export function registerCostRoutes(app: FastifyInstance, deps: CostRoutesDeps) {
  app.get("/api/cost/snapshot", async (request, reply) => {
    const rates = deps.getRates();
    if (!rates) {
      return reply.code(204).send();
    }
    const snapshot = await deps.scopedSnapshot(request);
    return buildSnapshotCost(snapshot, rates);
  });

  app.get<{ Querystring: { group_by?: string } }>("/api/cost/by-dimension", async (request, reply) => {
    const rates = deps.getRates();
    if (!rates) {
      return reply.code(204).send();
    }
    const raw = (request.query.group_by ?? "template").trim() || "template";
    const groupBy = parseGroupBy(raw);
    if (!groupBy) {
      return reply.code(400).send({ message: "group_by must be template, namespace, or label:<key>" });
    }
    const snapshot = await deps.scopedSnapshot(request);
    return buildCostByDimension(snapshot, rates, groupBy);
  });
}
