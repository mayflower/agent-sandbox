import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import {
  buildOverviewSnapshot,
  classifyProblems,
  mapEvents,
  normalizeClaims,
  normalizeSandboxes,
  normalizeTemplates,
  normalizeWarmPools,
  type InventoryProvider,
} from "@agent-sandbox/dashboard-shared";
import Fastify from "fastify";
import path from "node:path";
import { existsSync } from "node:fs";

export function buildApp(options: { provider: InventoryProvider; staticDir?: string }) {
  const app = Fastify({
    logger: false,
  });

  app.register(cors, { origin: true });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: "/",
      decorateReply: false,
      wildcard: false,
    });
  }

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/capabilities", async () => options.provider.getCapabilities());

  app.get("/api/overview", async () => {
    const snapshot = await options.provider.getSnapshot();
    return buildOverviewSnapshot(snapshot);
  });

  app.get("/api/sandboxes", async () => {
    const snapshot = await options.provider.getSnapshot();
    return normalizeSandboxes(snapshot);
  });

  app.get("/api/claims", async () => {
    const snapshot = await options.provider.getSnapshot();
    return normalizeClaims(snapshot);
  });

  app.get("/api/warm-pools", async () => {
    const snapshot = await options.provider.getSnapshot();
    return normalizeWarmPools(snapshot);
  });

  app.get("/api/templates", async () => {
    const snapshot = await options.provider.getSnapshot();
    return normalizeTemplates(snapshot);
  });

  app.get("/api/problems", async () => {
    const snapshot = await options.provider.getSnapshot();
    return classifyProblems(snapshot);
  });

  app.get<{
    Querystring: {
      namespace?: string;
      resourceKind?: string;
      resourceName?: string;
    };
  }>("/api/events", async (request) => {
    const snapshot = await options.provider.getSnapshot();
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
