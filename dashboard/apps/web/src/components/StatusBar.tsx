import {
  Moon,
  Pause,
  Play,
  RefreshCw,
  Sun,
} from "lucide-react";
import type { ControllerHealth } from "@agent-sandbox/dashboard-shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useFilters } from "@/lib/filters";
import { useNow } from "@/lib/now";
import { cn } from "@/lib/utils";

export interface StatusBarProps {
  pageTitle: string;
  namespaces: string[];
  overall: "ok" | "warning" | "error";
  errorCount: number;
  warningCount: number;
  controllerHealth: ControllerHealth | null;
  updatedAt: number;
  isFetching: boolean;
  paused: boolean;
  onTogglePause(): void;
  theme: "light" | "dark";
  onToggleTheme(): void;
  onRefresh(): void;
  filterActive: boolean;
  visibleCount: number;
  totalCount: number;
}

const CRISIS_THRESHOLD = 3;

export function StatusBar({
  pageTitle,
  namespaces,
  overall,
  errorCount,
  warningCount,
  controllerHealth,
  updatedAt,
  isFetching,
  paused,
  onTogglePause,
  theme,
  onToggleTheme,
  onRefresh,
  filterActive,
  visibleCount,
  totalCount,
}: StatusBarProps) {
  const filters = useFilters();
  const nowMs = useNow();

  const crisis = errorCount >= CRISIS_THRESHOLD;

  return (
    <header
      className={cn(
        "sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-4",
        crisis && "border-rose-500/50 shadow-[inset_0_0_0_1px_rgba(244,63,94,0.4)]",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            overall === "ok" && "bg-emerald-500",
            overall === "warning" && "bg-amber-500",
            overall === "error" && "bg-rose-500",
          )}
          aria-hidden
        />
        <h1 className="text-sm font-semibold">{pageTitle}</h1>
      </div>
      <Badge
        tone={errorCount > 0 ? "danger" : warningCount > 0 ? "warning" : "success"}
        className="ml-1"
        title={`${errorCount} error${errorCount === 1 ? "" : "s"} · ${warningCount} warning${warningCount === 1 ? "" : "s"}`}
      >
        {errorCount} · {warningCount}
      </Badge>
      {controllerHealth && (
        <Badge tone={controllerHealth.available ? "success" : "danger"} title={controllerHealth.reason}>
          ctrl {controllerHealth.ready}/{controllerHealth.desired}
        </Badge>
      )}

      <div className="ml-auto flex flex-1 items-center justify-end gap-1.5">
        <div className="relative w-full max-w-[18rem]">
          <Input
            type="search"
            placeholder="search name…"
            value={filters.search}
            onChange={(event) => filters.setSearch(event.target.value)}
            className="h-8 pr-14 text-xs"
            aria-label="Search resources by name"
          />
          {filterActive && (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground">
              {visibleCount}/{totalCount}
            </span>
          )}
        </div>
        <Select value={filters.namespace || "__all"} onValueChange={(value) => filters.setNamespace(value === "__all" ? "" : value)}>
          <SelectTrigger className="h-8 w-[11rem] text-xs" aria-label="Filter by namespace">
            <SelectValue placeholder="all namespaces" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">all namespaces</SelectItem>
            {namespaces.map((namespace) => (
              <SelectItem key={namespace} value={namespace}>
                {namespace}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs">
          <input
            type="checkbox"
            checked={filters.brokenOnly}
            onChange={(event) => filters.setBrokenOnly(event.target.checked)}
            className="h-3 w-3"
          />
          broken only
        </label>
        {(filters.search || filters.namespace || filters.brokenOnly) && (
          <Button size="sm" variant="ghost" className="h-8" onClick={filters.reset}>
            clear
          </Button>
        )}
      </div>

      <Separator orientation="vertical" className="mx-1 h-4" />
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {paused ? "paused" : `updated ${formatRelative(updatedAt, nowMs)}`}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onTogglePause}
          aria-label={paused ? "Resume auto refresh" : "Pause auto refresh"}
          title={paused ? "Resume auto refresh" : "Pause auto refresh"}
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onRefresh}
          disabled={isFetching}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </header>
  );
}

function formatRelative(updatedAt: number, nowMs: number): string {
  if (!updatedAt) return "never";
  const delta = Math.max(0, Math.floor((nowMs - updatedAt) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}
