import type { ControllerHealth, ProblemView } from "@agent-sandbox/dashboard-shared";
import { useEffect, useState } from "react";

import { useFilters } from "../lib/filters.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";

function formatRelative(updatedAt: number, nowMs: number): string {
  if (!updatedAt) return "never";
  const delta = Math.max(0, Math.floor((nowMs - updatedAt) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

interface StatusBarProps {
  problems: ProblemView[];
  namespaces: string[];
  updatedAt: number;
  onRefresh: () => void;
  isFetching: boolean;
  controllerHealth: ControllerHealth | null;
}

export function StatusBar({ problems, namespaces, updatedAt, onRefresh, isFetching, controllerHealth }: StatusBarProps) {
  const filters = useFilters();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const errorCount = problems.filter((problem) => problem.severity === "error").length;
  const warningCount = problems.filter((problem) => problem.severity === "warning").length;
  const controllerDown = controllerHealth !== null && !controllerHealth.available;
  const overall: "ok" | "warning" | "error" =
    controllerDown || errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok";

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:px-6">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              overall === "ok" && "bg-emerald-500",
              overall === "warning" && "bg-amber-500",
              overall === "error" && "bg-rose-500",
            )}
            aria-hidden
          />
          <h1 className="text-sm font-semibold text-slate-900">Agent Sandbox</h1>
          <Badge tone={overall === "ok" ? "success" : overall === "warning" ? "warning" : "danger"}>
            {overall === "ok" ? "all clear" : `${errorCount} error${errorCount === 1 ? "" : "s"} · ${warningCount} warning${warningCount === 1 ? "" : "s"}`}
          </Badge>
          {controllerHealth && (
            <Badge tone={controllerHealth.available ? "success" : "danger"}>
              controller {controllerHealth.available ? "ok" : `down (${controllerHealth.ready}/${controllerHealth.desired})`}
            </Badge>
          )}
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="search name…"
            value={filters.search}
            onChange={(event) => filters.setSearch(event.target.value)}
            className="min-w-[10rem] flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-accent focus:outline-none"
            aria-label="Search resources by name"
          />
          <select
            value={filters.namespace}
            onChange={(event) => filters.setNamespace(event.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-accent focus:outline-none"
            aria-label="Filter by namespace"
          >
            <option value="">all namespaces</option>
            {namespaces.map((namespace) => (
              <option key={namespace} value={namespace}>
                {namespace}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900">
            <input
              type="checkbox"
              checked={filters.brokenOnly}
              onChange={(event) => filters.setBrokenOnly(event.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            broken only
          </label>
          {(filters.search || filters.namespace || filters.brokenOnly) && (
            <button
              type="button"
              onClick={filters.reset}
              className="rounded-md px-2 py-1 text-xs text-slate-600 hover:text-slate-900"
            >
              clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="tabular-nums">updated {formatRelative(updatedAt, nowMs)}</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isFetching ? "refreshing…" : "refresh"}
          </button>
        </div>
      </div>
    </header>
  );
}
