import { computeLiveOverview, viewForKind, type InventoryView } from "@agent-sandbox/dashboard-shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  FileText,
  LayoutDashboard,
  Layers,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Scroll,
  Sun,
  Thermometer,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EventsFeed } from "@/components/EventsFeed";
import { InventorySection } from "@/components/InventorySection";
import { OverviewSection } from "@/components/OverviewSection";
import { PendingClaimsByReason } from "@/components/PendingClaimsByReason";
import { ProblemsPanel } from "@/components/ProblemsPanel";
import { WarmPoolMatrix } from "@/components/WarmPoolMatrix";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { FilterProvider, useFilters } from "@/lib/filters";
import { useTheme } from "@/lib/useTheme";
import { cn, matchesSearch } from "@/lib/utils";

const POLL_MS = 5000;

type View = "overview" | InventoryView | "events";

const NAV_LABEL: Record<View, string> = {
  overview: "Overview",
  sandboxes: "Sandboxes",
  claims: "Claims",
  "warm-pools": "Warm pools",
  templates: "Templates",
  events: "Events",
};

export default function App() {
  return (
    <FilterProvider>
      <AppContent />
    </FilterProvider>
  );
}

function AppContent() {
  const filters = useFilters();
  const queryClient = useQueryClient();
  const { theme, toggle: toggleTheme } = useTheme();
  const [paused, setPaused] = useState(false);
  const [view, setView] = useState<View>("overview");
  const interval: number | false = paused ? false : POLL_MS;

  useEffect(() => {
    const target = filters.target;
    if (!target) return;
    const desired = viewForKind(target.resourceKind);
    if (view !== desired) {
      setView(desired);
    }
  }, [filters.target, view]);

  const capabilitiesQuery = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, refetchInterval: interval });
  const sandboxesQuery = useQuery({ queryKey: ["sandboxes"], queryFn: api.sandboxes, refetchInterval: interval });
  const claimsQuery = useQuery({ queryKey: ["claims"], queryFn: api.claims, enabled: capabilitiesQuery.data?.claims === true, refetchInterval: interval });
  const warmPoolsQuery = useQuery({ queryKey: ["warm-pools"], queryFn: api.warmPools, enabled: capabilitiesQuery.data?.warmPools === true, refetchInterval: interval });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates, enabled: capabilitiesQuery.data?.templates === true, refetchInterval: interval });
  const problemsQuery = useQuery({ queryKey: ["problems"], queryFn: api.problems, refetchInterval: interval });
  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: () => api.events(),
    enabled: capabilitiesQuery.data?.events === true,
    refetchInterval: interval,
  });
  const controllerHealthQuery = useQuery({
    queryKey: ["controller-health"],
    queryFn: api.controllerHealth,
    enabled: capabilitiesQuery.data?.controllerHealth === true,
    refetchInterval: interval,
  });
  const queryErrors = [
    capabilitiesQuery.isError && { name: "capabilities", error: capabilitiesQuery.error },
    sandboxesQuery.isError && { name: "sandboxes", error: sandboxesQuery.error },
    problemsQuery.isError && { name: "problems", error: problemsQuery.error },
    capabilitiesQuery.data?.claims === true && claimsQuery.isError && { name: "claims", error: claimsQuery.error },
    capabilitiesQuery.data?.warmPools === true && warmPoolsQuery.isError && { name: "warm-pools", error: warmPoolsQuery.error },
    capabilitiesQuery.data?.templates === true && templatesQuery.isError && { name: "templates", error: templatesQuery.error },
    capabilitiesQuery.data?.events === true && eventsQuery.isError && { name: "events", error: eventsQuery.error },
  ].filter(
    (entry): entry is { name: string; error: unknown } => entry !== false,
  );

  const namespaces = useMemo(() => {
    const set = new Set<string>();
    sandboxesQuery.data?.forEach((sandbox) => sandbox.namespace && set.add(sandbox.namespace));
    claimsQuery.data?.forEach((claim) => claim.namespace && set.add(claim.namespace));
    warmPoolsQuery.data?.forEach((warmPool) => warmPool.namespace && set.add(warmPool.namespace));
    templatesQuery.data?.forEach((template) => template.namespace && set.add(template.namespace));
    return [...set].sort((left, right) => left.localeCompare(right));
  }, [sandboxesQuery.data, claimsQuery.data, warmPoolsQuery.data, templatesQuery.data]);

  const filteredSandboxes = useMemo(() => {
    return (sandboxesQuery.data ?? []).filter(
      (sandbox) =>
        matchesSearch(sandbox.name, sandbox.namespace, filters.search) &&
        (!filters.namespace || sandbox.namespace === filters.namespace) &&
        (!filters.brokenOnly || !sandbox.effectiveReady),
    );
  }, [sandboxesQuery.data, filters.search, filters.namespace, filters.brokenOnly]);
  const filteredClaims = useMemo(() => {
    return (claimsQuery.data ?? []).filter(
      (claim) =>
        matchesSearch(claim.name, claim.namespace, filters.search) &&
        (!filters.namespace || claim.namespace === filters.namespace) &&
        (!filters.brokenOnly || !claim.effectiveReady || claim.readinessMismatch),
    );
  }, [claimsQuery.data, filters.search, filters.namespace, filters.brokenOnly]);
  const filteredWarmPools = useMemo(() => {
    return (warmPoolsQuery.data ?? []).filter(
      (pool) =>
        matchesSearch(pool.name, pool.namespace, filters.search) &&
        (!filters.namespace || pool.namespace === filters.namespace) &&
        (!filters.brokenOnly || pool.readyReplicas < pool.desiredReplicas),
    );
  }, [warmPoolsQuery.data, filters.search, filters.namespace, filters.brokenOnly]);
  const filteredTemplates = useMemo(() => {
    return (templatesQuery.data ?? []).filter(
      (template) =>
        matchesSearch(template.name, template.namespace, filters.search) &&
        (!filters.namespace || template.namespace === filters.namespace),
    );
  }, [templatesQuery.data, filters.search, filters.namespace]);

  const liveOverview = useMemo(
    () => computeLiveOverview(filteredSandboxes, filteredClaims, filteredWarmPools),
    [filteredSandboxes, filteredClaims, filteredWarmPools],
  );

  const totalRawCount =
    (sandboxesQuery.data?.length ?? 0) +
    (claimsQuery.data?.length ?? 0) +
    (warmPoolsQuery.data?.length ?? 0) +
    (templatesQuery.data?.length ?? 0);
  const visibleCount =
    filteredSandboxes.length + filteredClaims.length + filteredWarmPools.length + filteredTemplates.length;
  const filterActive = visibleCount !== totalRawCount;

  const problems = problemsQuery.data ?? [];
  const errorCount = problems.filter((problem) => problem.severity === "error").length;
  const warningCount = problems.filter((problem) => problem.severity === "warning").length;
  const controllerHealth = controllerHealthQuery.data ?? null;
  const controllerDown = controllerHealth !== null && !controllerHealth.available;
  const overall: "ok" | "warning" | "error" =
    controllerDown || errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok";

  const updatedAt = Math.max(
    capabilitiesQuery.dataUpdatedAt ?? 0,
    sandboxesQuery.dataUpdatedAt ?? 0,
    claimsQuery.dataUpdatedAt ?? 0,
    warmPoolsQuery.dataUpdatedAt ?? 0,
    templatesQuery.dataUpdatedAt ?? 0,
    problemsQuery.dataUpdatedAt ?? 0,
    eventsQuery.dataUpdatedAt ?? 0,
    controllerHealthQuery.dataUpdatedAt ?? 0,
  );
  const isFetching =
    sandboxesQuery.isFetching ||
    problemsQuery.isFetching ||
    claimsQuery.isFetching ||
    warmPoolsQuery.isFetching;
  const refresh = () => queryClient.invalidateQueries();

  if (capabilitiesQuery.isLoading || sandboxesQuery.isLoading || problemsQuery.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading dashboard snapshot…
      </main>
    );
  }

  if (queryErrors.length > 0) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6 text-sm text-destructive">
        <div className="space-y-2">
          <p className="font-semibold">Dashboard snapshot failed to load.</p>
          <ul className="list-disc pl-5 text-xs font-mono">
            {queryErrors.map(({ name, error }) => (
              <li key={name}>
                <span className="font-semibold">{name}</span>: {error instanceof Error ? error.message : String(error)}
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  const pageTitle = NAV_LABEL[view];

  return (
    <SidebarProvider>
      <AppSidebar view={view} onViewChange={setView} capabilities={capabilitiesQuery.data!} />
      <SidebarInset>
        <TopBar
          pageTitle={pageTitle}
          namespaces={namespaces}
          overall={overall}
          errorCount={errorCount}
          warningCount={warningCount}
          controllerHealth={controllerHealth}
          updatedAt={updatedAt}
          isFetching={isFetching}
          paused={paused}
          onTogglePause={() => setPaused((prev) => !prev)}
          theme={theme}
          onToggleTheme={toggleTheme}
          onRefresh={refresh}
          filterActive={filterActive}
          visibleCount={visibleCount}
          totalCount={totalRawCount}
        />
        <div className="flex-1 space-y-3 p-4 md:p-6">
          {view === "overview" && (
            <div className="space-y-3">
              <OverviewSection overview={liveOverview} />
              <div className="grid gap-3 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)_minmax(280px,1fr)]">
                <ProblemsPanel problems={problemsQuery.data ?? []} />
                <div className="space-y-3 xl:col-auto">
                  <WarmPoolMatrix warmPools={filteredWarmPools} />
                </div>
                <div className="space-y-3">
                  <PendingClaimsByReason items={liveOverview.pendingClaimsByReason} />
                  <EventsFeed events={eventsQuery.data ?? []} />
                </div>
              </div>
            </div>
          )}
          {view !== "overview" && view !== "events" && (
            <InventorySection
              view={view}
              sandboxes={filteredSandboxes}
              claims={filteredClaims}
              warmPools={filteredWarmPools}
              templates={filteredTemplates}
              rawSandboxes={sandboxesQuery.data ?? []}
              rawClaims={claimsQuery.data ?? []}
              rawWarmPools={warmPoolsQuery.data ?? []}
              rawTemplates={templatesQuery.data ?? []}
              events={eventsQuery.data ?? []}
            />
          )}
          {view === "events" && <EventsFeed events={eventsQuery.data ?? []} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebar({
  view,
  onViewChange,
  capabilities,
}: {
  view: View;
  onViewChange: (view: View) => void;
  capabilities: { claims: boolean; warmPools: boolean; templates: boolean; events: boolean };
}) {
  const resources: Array<{ key: View; label: string; icon: typeof Boxes; enabled: boolean }> = [
    { key: "sandboxes", label: "Sandboxes", icon: Boxes, enabled: true },
    { key: "claims", label: "Claims", icon: FileText, enabled: capabilities.claims },
    { key: "warm-pools", label: "Warm pools", icon: Thermometer, enabled: capabilities.warmPools },
    { key: "templates", label: "Templates", icon: Layers, enabled: capabilities.templates },
  ];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground">
            <LayoutDashboard className="h-3.5 w-3.5" />
          </div>
          <span className="truncate text-sm font-semibold">agent-sandbox</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view === "overview"}
                  onClick={() => onViewChange("overview")}
                  tooltip="Overview"
                >
                  <LayoutDashboard />
                  <span>Overview</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {resources
                .filter((item) => item.enabled)
                .map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      isActive={view === item.key}
                      onClick={() => onViewChange(item.key)}
                      tooltip={item.label}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {capabilities.events && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "events"}
                    onClick={() => onViewChange("events")}
                    tooltip="Events"
                  >
                    <Scroll />
                    <span>Events</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
    </Sidebar>
  );
}

function TopBar({
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
}: {
  pageTitle: string;
  namespaces: string[];
  overall: "ok" | "warning" | "error";
  errorCount: number;
  warningCount: number;
  controllerHealth: { available: boolean; ready: number; desired: number; reason?: string } | null;
  updatedAt: number;
  isFetching: boolean;
  paused: boolean;
  onTogglePause: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onRefresh: () => void;
  filterActive: boolean;
  visibleCount: number;
  totalCount: number;
}) {
  const filters = useFilters();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
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
