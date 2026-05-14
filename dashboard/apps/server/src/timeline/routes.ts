import type { FastifyInstance } from "fastify";
import { compileStory } from "@agent-sandbox/dashboard-shared";
import type { TimelineStore } from "./timeline-store.js";

interface TimelineParams {
  Params: { namespace: string; name: string };
}

export function registerTimelineRoutes(app: FastifyInstance, store: TimelineStore) {
  app.get<TimelineParams>("/api/timeline/sandbox/:namespace/:name", async (request) => {
    const { namespace, name } = request.params;
    const events = store.list({ namespace, name });
    return { events, story: compileStory(events) };
  });
}
