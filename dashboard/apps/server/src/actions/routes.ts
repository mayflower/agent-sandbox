import type { FastifyInstance } from "fastify";
import type { Identity, InventoryProvider } from "@agent-sandbox/dashboard-shared";

interface ActionParams {
  Params: { namespace: string; name: string };
}

function canActOnNamespace(identity: Identity, namespace: string): boolean {
  if (identity.role === "operator") return true;
  return identity.namespaces.includes(namespace);
}

export interface ActionRoutesDeps {
  provider: InventoryProvider;
}

export function registerActionRoutes(app: FastifyInstance, deps: ActionRoutesDeps) {
  app.post<ActionParams & { Querystring: { seconds?: string } }>(
    "/api/actions/claim/:namespace/:name/extend",
    async (request, reply) => {
      const { namespace, name } = request.params;
      if (!canActOnNamespace(request.identity, namespace)) {
        return reply.code(403).send({ message: "namespace not in identity scope" });
      }
      if (!deps.provider.patchClaimLifecycle) {
        return reply.code(501).send({ message: "Action not supported by provider" });
      }
      const seconds = Number(request.query.seconds ?? "1800");
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 60 * 60) {
        return reply.code(400).send({ message: "seconds must be a positive number ≤ 86400" });
      }
      const newShutdown = new Date(Date.now() + seconds * 1000).toISOString();
      await deps.provider.patchClaimLifecycle(namespace, name, { shutdownTime: newShutdown });
      return { kind: "SandboxClaim", namespace, name, action: "extended", shutdownTime: newShutdown };
    },
  );

  app.post<ActionParams>("/api/actions/sandbox/:namespace/:name/pause", async (request, reply) => {
    const { namespace, name } = request.params;
    if (!canActOnNamespace(request.identity, namespace)) {
      return reply.code(403).send({ message: "namespace not in identity scope" });
    }
    if (!deps.provider.setSandboxReplicas) {
      return reply.code(501).send({ message: "Pause not supported by provider" });
    }
    await deps.provider.setSandboxReplicas(namespace, name, 0);
    return { kind: "Sandbox", namespace, name, action: "paused" };
  });

  app.post<ActionParams>("/api/actions/sandbox/:namespace/:name/resume", async (request, reply) => {
    const { namespace, name } = request.params;
    if (!canActOnNamespace(request.identity, namespace)) {
      return reply.code(403).send({ message: "namespace not in identity scope" });
    }
    if (!deps.provider.setSandboxReplicas) {
      return reply.code(501).send({ message: "Resume not supported by provider" });
    }
    await deps.provider.setSandboxReplicas(namespace, name, 1);
    return { kind: "Sandbox", namespace, name, action: "resumed" };
  });
}
