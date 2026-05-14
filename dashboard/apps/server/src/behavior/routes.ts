import type { FastifyInstance } from "fastify";
import {
  buildSandboxBehavior,
  normalizeAll,
  type InventoryProvider,
  type PodMetric,
} from "@agent-sandbox/dashboard-shared";
import { buildTemplateBehaviorFromSnapshot } from "./event-stats.js";

export interface BehaviorRoutesDeps {
  provider: InventoryProvider;
  /** Source of fresh per-pod usage metrics. Empty list disables anomaly detection. */
  getPodMetrics(): PodMetric[];
}

export function registerBehaviorRoutes(app: FastifyInstance, deps: BehaviorRoutesDeps) {
  app.get<{ Params: { namespace: string; name: string } }>(
    "/api/behavior/sandbox/:namespace/:name",
    async (request, reply) => {
      const { namespace, name } = request.params;
      const snapshot = await deps.provider.getSnapshot();
      const inventory = normalizeAll(snapshot);
      const sandbox = inventory.sandboxes.find(
        (entry) => entry.namespace === namespace && entry.name === name,
      );
      if (!sandbox) {
        return reply.code(404).send({ message: "sandbox not found" });
      }
      const metrics = deps.getPodMetrics();

      // Compute template median CPU usage (for anomaly threshold).
      const templateUsage = metrics
        .filter((metric) => {
          const candidate = inventory.sandboxes.find(
            (sb) => sb.namespace === metric.namespace && sb.podName === metric.podName,
          );
          return candidate?.templateRef === sandbox.templateRef;
        })
        .map((metric) => metric.cpuMilli);

      const sorted = templateUsage.sort((a, b) => a - b);
      const templateMedian = sorted.length
        ? sorted[Math.floor(sorted.length / 2)] ?? 0
        : 0;
      const behaviorInput: Parameters<typeof buildSandboxBehavior>[0] = {
        namespace: sandbox.namespace,
        name: sandbox.name,
      };
      if (sandbox.podName) behaviorInput.podName = sandbox.podName;
      if (sandbox.templateRef) behaviorInput.templateRef = sandbox.templateRef;
      return buildSandboxBehavior(behaviorInput, metrics, templateMedian);
    },
  );

  app.get<{ Params: { name: string } }>("/api/behavior/template/:name", async (request) => {
    const snapshot = await deps.provider.getSnapshot();
    return buildTemplateBehaviorFromSnapshot(snapshot, request.params.name);
  });
}
