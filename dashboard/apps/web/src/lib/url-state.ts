/**
 * URL <-> filter-state serialisation. Keeps the dashboard deep-linkable so
 * operators can copy a URL with namespace + search + broken-only + view +
 * scrubber position + open drawer and re-open it on another machine.
 */

export type AppView = "operator" | "tenant" | "story" | "cost";

export interface DrawerTarget {
  resourceKind: "Sandbox" | "SandboxClaim" | "SandboxWarmPool" | "SandboxTemplate";
  namespace: string;
  resourceName: string;
}

export interface UrlState {
  view: AppView;
  /** Selected inventory tab. Falls back per-view default if missing. */
  tab?: string;
  namespace: string;
  search: string;
  brokenOnly: boolean;
  /** ISO timestamp of the time-scrubber position. Empty == live. */
  scrubAt: string;
  /** Open drawer target (resource focus). */
  drawer?: DrawerTarget;
  /** Open expanded problem groups (by ProblemKind). */
  expandedProblems: string[];
  /** Story-view sandbox (only meaningful when view === "story"). */
  story?: { namespace: string; name: string };
}

export const DEFAULT_URL_STATE: UrlState = {
  view: "operator",
  namespace: "",
  search: "",
  brokenOnly: false,
  scrubAt: "",
  expandedProblems: [],
};

function pick(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  return value === null ? undefined : value;
}

function parseDrawer(raw: string | undefined): DrawerTarget | undefined {
  if (!raw) return undefined;
  const [kindRaw, rest] = raw.split(":");
  if (!kindRaw || !rest) return undefined;
  const [namespace, ...nameParts] = rest.split("/");
  if (!namespace || nameParts.length === 0) return undefined;
  const kind = ({
    sandbox: "Sandbox",
    claim: "SandboxClaim",
    "warm-pool": "SandboxWarmPool",
    template: "SandboxTemplate",
  } as const)[kindRaw];
  if (!kind) return undefined;
  return { resourceKind: kind, namespace, resourceName: nameParts.join("/") };
}

function serializeDrawer(target: DrawerTarget): string {
  const kind = ({
    Sandbox: "sandbox",
    SandboxClaim: "claim",
    SandboxWarmPool: "warm-pool",
    SandboxTemplate: "template",
  } as const)[target.resourceKind];
  return `${kind}:${target.namespace}/${target.resourceName}`;
}

export function parseUrlState(searchOrUrl: string | URL = window.location.search): UrlState {
  const params =
    typeof searchOrUrl === "string"
      ? new URLSearchParams(searchOrUrl.startsWith("?") ? searchOrUrl.slice(1) : searchOrUrl)
      : new URLSearchParams(searchOrUrl.search);

  const rawView = pick(params, "view");
  const view: AppView = (["operator", "tenant", "story", "cost"] as AppView[]).includes(rawView as AppView)
    ? (rawView as AppView)
    : "operator";
  const expanded = pick(params, "expanded");
  const drawer = parseDrawer(pick(params, "drawer"));
  const story = pick(params, "story");
  const storyTarget = story && story.includes("/") ? { namespace: story.split("/")[0]!, name: story.split("/").slice(1).join("/") } : undefined;

  const result: UrlState = {
    view,
    namespace: pick(params, "ns") ?? "",
    search: pick(params, "q") ?? "",
    brokenOnly: pick(params, "broken") === "1",
    scrubAt: pick(params, "at") ?? "",
    expandedProblems: expanded ? expanded.split(",").filter(Boolean) : [],
  };

  const tab = pick(params, "tab");
  if (tab) result.tab = tab;
  if (drawer) result.drawer = drawer;
  if (storyTarget) result.story = storyTarget;
  return result;
}

export function serializeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.view !== DEFAULT_URL_STATE.view) params.set("view", state.view);
  if (state.tab) params.set("tab", state.tab);
  if (state.namespace) params.set("ns", state.namespace);
  if (state.search) params.set("q", state.search);
  if (state.brokenOnly) params.set("broken", "1");
  if (state.scrubAt) params.set("at", state.scrubAt);
  if (state.drawer) params.set("drawer", serializeDrawer(state.drawer));
  if (state.expandedProblems.length > 0) params.set("expanded", state.expandedProblems.join(","));
  if (state.story) params.set("story", `${state.story.namespace}/${state.story.name}`);
  const query = params.toString();
  return query ? `?${query}` : "";
}
