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

  app.get("/api/controller-health", async (_request, reply) => {
    const snapshot = await options.provider.getSnapshot();
    if (!snapshot.controllerHealth) {
      return reply.code(204).send();
    }
    return snapshot.controllerHealth;
  });

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
