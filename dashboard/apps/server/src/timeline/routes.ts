import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { compileStory, type Identity } from "@agent-sandbox/dashboard-shared";
import type { TimelineStore } from "./timeline-store.js";

interface TimelineParams {
  Params: { namespace: string; name: string };
}

function canRead(identity: Identity, namespace: string): boolean {
  if (identity.role === "operator") return true;
  return identity.namespaces.includes(namespace);
}

export function registerTimelineRoutes(app: FastifyInstance, store: TimelineStore) {
  app.get<TimelineParams>(
    "/api/timeline/sandbox/:namespace/:name",
    async (request: FastifyRequest<TimelineParams>, reply: FastifyReply) => {
      const { namespace, name } = request.params;
      if (!canRead(request.identity, namespace)) {
        return reply.code(403).send({ message: "namespace not in identity scope" });
      }
      const events = store.list({ namespace, name });
      return { events, story: compileStory(events) };
    },
  );
}
