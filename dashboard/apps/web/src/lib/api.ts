import type {
  ActionResult,
  Capabilities,
  ClaimLiveView,
  ControllerHealth,
  CostByDimension,
  DashboardSnapshot,
  EventView,
  HistoryResolution,
  HistorySeries,
  Identity,
  InventorySnapshot,
  OverviewSnapshot,
  ProblemDag,
  ProblemView,
  SandboxBehavior,
  SandboxLiveView,
  SnapshotCost,
  SnapshotDiff,
  StoryRow,
  TemplateBehavior,
  TemplateLiveView,
  TimelineEvent,
  WarmPoolLiveView,
} from "@agent-sandbox/dashboard-shared";

export interface OrphanCleanupResult {
  attempted: number;
  failed: number;
  results: Array<{ namespace: string; name: string; ok: boolean; error?: string }>;
}

async function parseJsonOrThrow<T>(response: Response, path: string): Promise<T> {
  // Wrap the raw SyntaxError that response.json() throws so React Query
  // surfaces "Malformed JSON from /api/foo" instead of "Unexpected token <".
  try {
    return (await response.json()) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed JSON response from ${path}: ${detail}`);
  }
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return parseJsonOrThrow<T>(response, path);
}

async function requestJsonOrNull<T>(path: string): Promise<T | null> {
  const response = await fetch(path);
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return parseJsonOrThrow<T>(response, path);
}

async function postJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "POST" });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.message ?? "";
    } catch {
      detail = await response.text();
    }
    throw new Error(`${response.status}: ${detail || response.statusText}`);
  }
  return parseJsonOrThrow<T>(response, path);
}

export const api = {
  /** One-shot bundled snapshot — preferred by the SPA over the per-view
   *  routes since it collapses ~9 parallel polls into a single request. */
  dashboard: () => requestJson<DashboardSnapshot>("/api/snapshot"),
  capabilities: () => requestJson<Capabilities>("/api/capabilities"),
  identity: () => requestJson<Identity>("/api/identity"),
  overview: () => requestJson<OverviewSnapshot>("/api/overview"),
  sandboxes: () => requestJson<SandboxLiveView[]>("/api/sandboxes"),
  claims: () => requestJson<ClaimLiveView[]>("/api/claims"),
  warmPools: () => requestJson<WarmPoolLiveView[]>("/api/warm-pools"),
  templates: () => requestJson<TemplateLiveView[]>("/api/templates"),
  problems: () => requestJson<ProblemView[]>("/api/problems"),
  problemDag: () => requestJson<ProblemDag>("/api/problem-dag"),
  controllerHealth: () => requestJsonOrNull<ControllerHealth>("/api/controller-health"),
  historyMetrics: (params: { since?: string; until?: string; res?: HistoryResolution } = {}) => {
    const search = new URLSearchParams();
    if (params.since) search.set("since", params.since);
    if (params.until) search.set("until", params.until);
    if (params.res) search.set("res", params.res);
    const suffix = search.size > 0 ? `?${search}` : "";
    return requestJson<HistorySeries>(`/api/history/metrics${suffix}`);
  },
  historySnapshot: (at: string) => requestJson<InventorySnapshot>(`/api/history/snapshot?at=${encodeURIComponent(at)}`),
  historyDiff: (from: string, to: string) =>
    requestJson<SnapshotDiff>(
      `/api/history/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  costSnapshot: () => requestJsonOrNull<SnapshotCost>("/api/cost/snapshot"),
  costByDimension: (groupBy: "template" | "namespace" | string) =>
    requestJsonOrNull<CostByDimension>(`/api/cost/by-dimension?group_by=${encodeURIComponent(groupBy)}`),
  sandboxBehavior: (namespace: string, name: string) =>
    requestJson<SandboxBehavior>(`/api/behavior/sandbox/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`),
  templateBehavior: (name: string) => requestJson<TemplateBehavior>(`/api/behavior/template/${encodeURIComponent(name)}`),
  timeline: (namespace: string, name: string) =>
    requestJson<{ events: TimelineEvent[]; story: StoryRow[] }>(
      `/api/timeline/sandbox/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    ),
  deleteSandbox: (namespace: string, name: string) =>
    postJson<ActionResult>(`/api/sandboxes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/delete`),
  reconcileSandbox: (namespace: string, name: string) =>
    postJson<ActionResult>(`/api/sandboxes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/reconcile`),
  deleteClaim: (namespace: string, name: string) =>
    postJson<ActionResult>(`/api/claims/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/delete`),
  pauseSandbox: (namespace: string, name: string) =>
    postJson<ActionResult>(`/api/actions/sandbox/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/pause`),
  resumeSandbox: (namespace: string, name: string) =>
    postJson<ActionResult>(`/api/actions/sandbox/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/resume`),
  extendClaim: (namespace: string, name: string, seconds: number) =>
    postJson<{ shutdownTime: string }>(
      `/api/actions/claim/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/extend?seconds=${encodeURIComponent(String(seconds))}`,
    ),
  cleanupOrphans: () => postJson<OrphanCleanupResult>(`/api/orphans/cleanup`),
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
