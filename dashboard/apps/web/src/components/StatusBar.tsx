import type { ControllerHealth, ProblemView } from "@agent-sandbox/dashboard-shared";
import { useEffect, useState } from "react";

import { useFilters } from "../lib/filters.js";
import { cn } from "../lib/utils.js";

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
  paused: boolean;
  onTogglePause: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  resultCount: number;
  totalCount: number;
}

export function StatusBar({
  problems,
  namespaces,
  updatedAt,
  onRefresh,
  isFetching,
  controllerHealth,
  paused,
  onTogglePause,
  theme,
  onToggleTheme,
  resultCount,
  totalCount,
}: StatusBarProps) {
  const filters = useFilters();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const errorCount = problems.filter((problem) => problem.severity === "error").length;
  const warningCount = problems.filter((problem) => problem.severity === "warning").length;
  const controllerDown = controllerHealth !== null && !controllerHealth.available;
  const overall: "ok" | "warning" | "error" =
    controllerDown || errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok";
  const filtered = resultCount !== totalCount;

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const chipBase =
    "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium tabular-nums";
  const chipNeutral =
    "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200";

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <div className="mx-auto flex max-w-[96rem] flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-1.5 md:px-6">
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
          <h1 className="text-xs font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            agent-sandbox
          </h1>
          <span className={cn(chipBase, chipNeutral)} title="Errors and warnings across problem groups">
            <span className="text-rose-600 dark:text-rose-400">{errorCount}</span>
            <span className="text-slate-400">·</span>
            <span className="text-amber-600 dark:text-amber-400">{warningCount}</span>
          </span>
          {controllerHealth && (
            <span
              className={cn(
                chipBase,
                controllerHealth.available
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                  : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
              )}
              title={controllerHealth.reason ?? "Controller deployment readiness"}
            >
              ctrl {controllerHealth.ready}/{controllerHealth.desired}
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <div className="relative min-w-[10rem] flex-1">
            <input
              type="search"
              placeholder="search name…"
              value={filters.search}
              onChange={(event) => filters.setSearch(event.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 pr-14 text-xs text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              aria-label="Search resources by name"
            />
            {filtered && (
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                {resultCount}/{totalCount}
              </span>
            )}
          </div>
          <select
            value={filters.namespace}
            onChange={(event) => filters.setNamespace(event.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-sky-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            aria-label="Filter by namespace"
          >
            <option value="">all namespaces</option>
            {namespaces.map((namespace) => (
              <option key={namespace} value={namespace}>
                {namespace}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <input
              type="checkbox"
              checked={filters.brokenOnly}
              onChange={(event) => filters.setBrokenOnly(event.target.checked)}
              className="h-3 w-3"
            />
            broken only
          </label>
          {(filters.search || filters.namespace || filters.brokenOnly) && (
            <button
              type="button"
              onClick={filters.reset}
              className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            >
              clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">
            {paused ? "paused" : `updated ${formatRelative(updatedAt, nowMs)}`}
          </span>
          <button
            type="button"
            onClick={onTogglePause}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            aria-label={paused ? "Resume auto refresh" : "Pause auto refresh"}
            title={paused ? "Resume auto refresh" : "Pause auto refresh"}
          >
            {paused ? "▶" : "⏸"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {isFetching ? "…" : "refresh"}
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </div>
    </header>
  );
}
