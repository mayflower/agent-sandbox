import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import {
  buildOverviewSnapshot,
  classifyProblems,
  diffSnapshots,
  captureSnapshot,
  buildProblemDag,
  mapEvents,
  normalizeClaims,
  normalizeSandboxes,
  normalizeTemplates,
  normalizeWarmPools,
  type CostRates,
  type Identity,
  type InventoryProvider,
  type PodMetric,
  type TenancyConfig,
} from "@agent-sandbox/dashboard-shared";
import Fastify from "fastify";
import path from "node:path";
import { existsSync } from "node:fs";

import { HistoryStore } from "./history/history-store.js";
import { registerHistoryRoutes } from "./history/routes.js";
import { TimelineStore } from "./timeline/timeline-store.js";
import { registerTimelineRoutes } from "./timeline/routes.js";
import { registerCostRoutes } from "./cost/routes.js";
import { registerActionRoutes } from "./actions/routes.js";
import { registerBehaviorRoutes } from "./behavior/routes.js";
import { attachIdentity } from "./identity/middleware.js";
import { filterSnapshotForIdentity } from "./identity/filter-snapshot.js";

export interface BuildAppOptions {
  provider: InventoryProvider;
  staticDir?: string;
  historyStore?: HistoryStore;
  timelineStore?: TimelineStore;
  getCostRates?(): CostRates | null;
  getPodMetrics?(): PodMetric[];
  tenancyConfig?: TenancyConfig;
}

export function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: false,
  });

  const historyStore = options.historyStore ?? new HistoryStore();
  const timelineStore = options.timelineStore ?? new TimelineStore();
  const getCostRates = options.getCostRates ?? (() => null);
  const getPodMetrics = options.getPodMetrics ?? (() => []);

  app.register(cors, { origin: true });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: "/",
      decorateReply: false,
      wildcard: false,
    });
  }

  if (options.tenancyConfig) {
    app.addHook("onRequest", async (request, reply) => {
      try {
        await attachIdentity(request, reply, {
          config: options.tenancyConfig!,
          provider: options.provider,
        });
      } catch (error) {
        // Identity resolution must never block the request — fall back to a
        // synthetic operator identity so the rest of the API keeps working.
        request.identity = { user: "operator", role: "operator", namespaces: [], groups: [] };
      }
    });
  } else {
    app.addHook("onRequest", async (request) => {
      request.identity = { user: "operator", role: "operator", namespaces: [], groups: [] };
    });
  }

  async function scopedSnapshot(identity: Identity) {
    const snapshot = await options.provider.getSnapshot();
    return filterSnapshotForIdentity(snapshot, identity);
  }

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/capabilities", async () => options.provider.getCapabilities());

  app.get("/api/identity", async (request) => request.identity);

  app.get("/api/controller-health", async (_request, reply) => {
    const snapshot = await options.provider.getSnapshot();
    if (!snapshot.controllerHealth) {
      return reply.code(204).send();
    }
    return snapshot.controllerHealth;
  });

  app.get("/api/overview", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    return buildOverviewSnapshot(snapshot);
  });

  app.get("/api/sandboxes", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    return normalizeSandboxes(snapshot);
  });

  app.get("/api/claims", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    return normalizeClaims(snapshot);
  });

  app.get("/api/warm-pools", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    return normalizeWarmPools(snapshot);
  });

  app.get("/api/templates", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    return normalizeTemplates(snapshot);
  });

  app.get("/api/problems", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    return classifyProblems(snapshot);
  });

  app.get("/api/problem-dag", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    return buildProblemDag(classifyProblems(snapshot));
  });

  registerHistoryRoutes(app, historyStore);
  registerTimelineRoutes(app, timelineStore);
  registerCostRoutes(app, { provider: options.provider, getRates: getCostRates });
  registerActionRoutes(app, { provider: options.provider });
  registerBehaviorRoutes(app, { provider: options.provider, getPodMetrics });

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/history/diff",
    async (request, reply) => {
      if (!request.query.from || !request.query.to) {
        return reply.code(400).send({ message: "from and to query parameters required" });
      }
      const fromTime = Date.parse(request.query.from);
      const toTime = Date.parse(request.query.to);
      if (Number.isNaN(fromTime) || Number.isNaN(toTime)) {
        return reply.code(400).send({ message: "from and to must be ISO 8601" });
      }
      const fromSnapshot = historyStore.snapshotAt(fromTime);
      const toSnapshot = historyStore.snapshotAt(toTime);
      if (!fromSnapshot || !toSnapshot) {
        return reply.code(404).send({ message: "snapshot pair not in history" });
      }
      return diffSnapshots(
        captureSnapshot(fromSnapshot, new Date(fromTime).toISOString()),
        captureSnapshot(toSnapshot, new Date(toTime).toISOString()),
      );
    },
  );

  interface ActionParams {
    Params: { namespace: string; name: string };
  }

  const ORPHAN_MIN_AGE_SECONDS = 600; // 10 min safety margin

  function audit(line: string) {
    // eslint-disable-next-line no-console
    console.log(`[action] ${new Date().toISOString()} ${line}`);
  }

  app.post<ActionParams>("/api/sandboxes/:namespace/:name/delete", async (request, reply) => {
    if (!options.provider.deleteSandbox) {
      return reply.code(501).send({ message: "Deletion not supported by provider" });
    }
    const { namespace, name } = request.params;
    const snapshot = await options.provider.getSnapshot();
    const sandboxes = normalizeSandboxes(snapshot);
    const target = sandboxes.find((sandbox) => sandbox.namespace === namespace && sandbox.name === name);
    if (!target) {
      return reply.code(404).send({ message: "Sandbox not found" });
    }
    const isOrphan = target.runtimeState === "missing" && target.ageSeconds >= ORPHAN_MIN_AGE_SECONDS;
    const isExpiredOrRetained = target.objectState === "expired" || target.objectState === "retained";
    if (!isOrphan && !isExpiredOrRetained) {
      return reply.code(409).send({
        message: "Sandbox still has a runtime or is too young to delete from the dashboard",
        objectState: target.objectState,
        runtimeState: target.runtimeState,
        ageSeconds: target.ageSeconds,
      });
    }
    await options.provider.deleteSandbox(namespace, name);
    audit(`delete sandbox ${namespace}/${name} reason=${isOrphan ? "orphan" : "expired"}`);
    return { kind: "Sandbox", namespace, name, action: "deleted" };
  });

  app.post<ActionParams>("/api/sandboxes/:namespace/:name/reconcile", async (request, reply) => {
    if (!options.provider.reconcileSandbox) {
      return reply.code(501).send({ message: "Reconcile not supported by provider" });
    }
    const { namespace, name } = request.params;
    const snapshot = await options.provider.getSnapshot();
    const sandbox = snapshot.sandboxes.find(
      (entry) => entry.metadata.name === name && (entry.metadata.namespace ?? "default") === namespace,
    );
    if (!sandbox) {
      return reply.code(404).send({ message: "Sandbox not found" });
    }
    await options.provider.reconcileSandbox(namespace, name);
    audit(`reconcile sandbox ${namespace}/${name}`);
    return { kind: "Sandbox", namespace, name, action: "reconciled" };
  });

  app.post<ActionParams>("/api/claims/:namespace/:name/delete", async (request, reply) => {
    if (!options.provider.deleteClaim) {
      return reply.code(501).send({ message: "Deletion not supported by provider" });
    }
    const { namespace, name } = request.params;
    const snapshot = await options.provider.getSnapshot();
    const claim = snapshot.claims.find(
      (entry) => entry.metadata.name === name && (entry.metadata.namespace ?? "default") === namespace,
    );
    if (!claim) {
      return reply.code(404).send({ message: "Claim not found" });
    }
    const templateRef = claim.spec.sandboxTemplateRef.name;
    const templateExists = snapshot.templates.some(
      (template) =>
        template.metadata.name === templateRef && (template.metadata.namespace ?? "default") === namespace,
    );
    if (templateExists) {
      return reply.code(409).send({
        message: "Referenced template exists; dashboard only deletes claims whose template is missing",
        templateRef,
      });
    }
    await options.provider.deleteClaim(namespace, name);
    audit(`delete claim ${namespace}/${name} reason=missing-template ref=${templateRef}`);
    return { kind: "SandboxClaim", namespace, name, action: "deleted" };
  });

  app.post("/api/orphans/cleanup", async (_request, reply) => {
    if (!options.provider.deleteSandbox) {
      return reply.code(501).send({ message: "Deletion not supported by provider" });
    }
    const snapshot = await options.provider.getSnapshot();
    const sandboxes = normalizeSandboxes(snapshot);
    const orphans = sandboxes.filter(
      (sandbox) =>
        sandbox.objectState === "active" &&
        sandbox.runtimeState === "missing" &&
        sandbox.ageSeconds >= ORPHAN_MIN_AGE_SECONDS,
    );
    const results = [] as Array<{ namespace: string; name: string; ok: boolean; error?: string }>;
    for (const sandbox of orphans) {
      try {
        await options.provider.deleteSandbox(sandbox.namespace, sandbox.name);
        audit(`delete sandbox ${sandbox.namespace}/${sandbox.name} reason=orphan-bulk`);
        results.push({ namespace: sandbox.namespace, name: sandbox.name, ok: true });
      } catch (error) {
        results.push({
          namespace: sandbox.namespace,
          name: sandbox.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { attempted: orphans.length, results };
  });

  app.get<{
    Querystring: {
      namespace?: string;
      resourceKind?: string;
      resourceName?: string;
    };
  }>("/api/events", async (request) => {
    const snapshot = await scopedSnapshot(request.identity);
    const events = mapEvents(snapshot);
    return events.filter((event) => {
      if (request.query.namespace && event.namespace !== request.query.namespace) {
        return false;
      }
      if (request.query.resourceKind && event.resourceKind !== request.query.resourceKind) {
        return false;
      }
      if (request.query.resourceName && event.resourceName !== request.query.resourceName) {
        return false;
      }
      return true;
    });
  });

  app.get("/*", async (_request, reply) => {
    if (options.staticDir && existsSync(path.join(options.staticDir, "index.html"))) {
      return reply.sendFile("index.html");
    }

    return reply.code(404).send({ message: "Not Found" });
  });

  return app;
}
