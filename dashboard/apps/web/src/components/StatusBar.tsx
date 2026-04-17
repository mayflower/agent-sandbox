import type { ProblemView } from "@agent-sandbox/dashboard-shared";
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
}

export function StatusBar({ problems, namespaces, updatedAt, onRefresh, isFetching }: StatusBarProps) {
  const filters = useFilters();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const errorCount = problems.filter((problem) => problem.severity === "error").length;
  const warningCount = problems.filter((problem) => problem.severity === "warning").length;
  const overall: "ok" | "warning" | "error" = errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok";

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b border-emerald-200/70 bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-8">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              overall === "ok" && "bg-emerald-500",
              overall === "warning" && "bg-amber-500",
              overall === "error" && "bg-rose-500",
            )}
            aria-hidden
          />
          <h1 className="font-display text-xl text-ink">Agent Sandbox</h1>
          <Badge tone={overall === "ok" ? "success" : overall === "warning" ? "warning" : "danger"}>
            {overall === "ok" ? "all clear" : `${errorCount} error${errorCount === 1 ? "" : "s"} · ${warningCount} warning${warningCount === 1 ? "" : "s"}`}
          </Badge>
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="search name…"
            value={filters.search}
            onChange={(event) => filters.setSearch(event.target.value)}
            className="min-w-[10rem] flex-1 rounded-full border border-stone-300 bg-white/80 px-4 py-1.5 text-sm text-ink placeholder:text-stone-400 focus:border-accent focus:outline-none"
            aria-label="Search resources by name"
          />
          <select
            value={filters.namespace}
            onChange={(event) => filters.setNamespace(event.target.value)}
            className="rounded-full border border-stone-300 bg-white/80 px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            aria-label="Filter by namespace"
          >
            <option value="">all namespaces</option>
            {namespaces.map((namespace) => (
              <option key={namespace} value={namespace}>
                {namespace}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 rounded-full border border-stone-300 bg-white/80 px-3 py-1.5 text-sm text-ink">
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
              className="rounded-full px-3 py-1.5 text-xs uppercase tracking-wider text-stone-600 hover:text-ink"
            >
              clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-stone-600">
          <span>updated {formatRelative(updatedAt, nowMs)}</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className="rounded-full border border-accent/30 bg-white/80 px-3 py-1 font-semibold uppercase tracking-wider text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            {isFetching ? "refreshing…" : "refresh"}
          </button>
        </div>
      </div>
    </header>
  );
}
