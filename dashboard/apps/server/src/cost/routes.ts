import type { FastifyInstance } from "fastify";
import {
  buildCostByDimension,
  buildSnapshotCost,
  type CostRates,
  type InventoryProvider,
} from "@agent-sandbox/dashboard-shared";

export interface CostRoutesDeps {
  provider: InventoryProvider;
  getRates(): CostRates | null;
}

export function registerCostRoutes(app: FastifyInstance, deps: CostRoutesDeps) {
  app.get("/api/cost/snapshot", async (_request, reply) => {
    const rates = deps.getRates();
    if (!rates) {
      return reply.code(204).send();
    }
    const snapshot = await deps.provider.getSnapshot();
    return buildSnapshotCost(snapshot, rates);
  });

  app.get<{ Querystring: { group_by?: string } }>("/api/cost/by-dimension", async (request, reply) => {
    const rates = deps.getRates();
    if (!rates) {
      return reply.code(204).send();
    }
    const groupBy = (request.query.group_by ?? "template").trim() || "template";
    if (!["template", "namespace"].includes(groupBy) && !groupBy.startsWith("label:")) {
      return reply.code(400).send({ message: "group_by must be template, namespace, or label:<key>" });
    }
    const snapshot = await deps.provider.getSnapshot();
    return buildCostByDimension(snapshot, rates, groupBy);
  });
}
