import type {
  Capabilities,
  ClaimLiveView,
  ControllerHealth,
  EventView,
  OverviewSnapshot,
  ProblemView,
  SandboxLiveView,
  TemplateLiveView,
  WarmPoolLiveView,
} from "@agent-sandbox/dashboard-shared";

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function requestJsonOrNull<T>(path: string): Promise<T | null> {
  const response = await fetch(path);
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  capabilities: () => requestJson<Capabilities>("/api/capabilities"),
  overview: () => requestJson<OverviewSnapshot>("/api/overview"),
  sandboxes: () => requestJson<SandboxLiveView[]>("/api/sandboxes"),
  claims: () => requestJson<ClaimLiveView[]>("/api/claims"),
  warmPools: () => requestJson<WarmPoolLiveView[]>("/api/warm-pools"),
  templates: () => requestJson<TemplateLiveView[]>("/api/templates"),
  problems: () => requestJson<ProblemView[]>("/api/problems"),
  controllerHealth: () => requestJsonOrNull<ControllerHealth>("/api/controller-health"),
  events: (params?: { namespace?: string; resourceKind?: string; resourceName?: string }) => {
    const search = new URLSearchParams();
    if (params?.namespace) {
      search.set("namespace", params.namespace);
    }
    if (params?.resourceKind) {
      search.set("resourceKind", params.resourceKind);
    }
    if (params?.resourceName) {
      search.set("resourceName", params.resourceName);
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return requestJson<EventView[]>(`/api/events${suffix}`);
  },
};
