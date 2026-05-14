import {
  computeLiveOverview,
  viewForKind,
  type InventoryView,
} from "@agent-sandbox/dashboard-shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  DollarSign,
  FileText,
  LayoutDashboard,
  Layers,
  Scroll,
  Thermometer,
  User,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EventsFeed } from "@/components/EventsFeed";
import { InventorySection } from "@/components/InventorySection";
import { KpiStrip } from "@/components/KpiStrip";
import { OverviewSection } from "@/components/OverviewSection";
import { PendingClaimsByReason } from "@/components/PendingClaimsByReason";
import { ProblemsPanel } from "@/components/ProblemsPanel";
import { StatusBar } from "@/components/StatusBar";
import { SavedViewsTabs } from "@/components/SavedViewsTabs";
import { TimeScrubber } from "@/components/TimeScrubber";
import { WarmPoolMatrix } from "@/components/WarmPoolMatrix";
import { CostView } from "@/views/CostView";
import { TenantView } from "@/views/TenantView";
import { SandboxStoryView } from "@/views/SandboxStoryView";
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
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { FilterProvider, useFilters } from "@/lib/filters";
import { NowProvider } from "@/lib/now";
import { useTheme } from "@/lib/useTheme";
import { matchesSearch } from "@/lib/utils";

const POLL_MS = 5000;

type View = "overview" | InventoryView | "events" | "cost" | "tenant" | "story";

const NAV_LABEL: Record<View, string> = {
  overview: "Overview",
  sandboxes: "Sandboxes",
  claims: "Claims",
  "warm-pools": "Warm pools",
  templates: "Templates",
  events: "Events",
  cost: "Cost",
  tenant: "My team",
  story: "Story",
};

export default function App() {
  return (
    <NowProvider>
      <FilterProvider>
        <AppContent />
      </FilterProvider>
    </NowProvider>
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

  // Bridge global view selection from URL state.
  useEffect(() => {
    if (filters.view === "cost" && view !== "cost") setView("cost");
    if (filters.view === "tenant" && view !== "tenant") setView("tenant");
    if (filters.view === "story" && view !== "story") setView("story");
    if (filters.view === "operator" && (view === "cost" || view === "tenant" || view === "story"))
      setView("overview");
  }, [filters.view, view]);

  const capabilitiesQuery = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, refetchInterval: interval });
  const identityQuery = useQuery({ queryKey: ["identity"], queryFn: api.identity, refetchInterval: interval });
  const sandboxesQuery = useQuery({ queryKey: ["sandboxes"], queryFn: api.sandboxes, refetchInterval: interval });
  const claimsQuery = useQuery({ queryKey: ["claims"], queryFn: api.claims, enabled: capabilitiesQuery.data?.claims === true, refetchInterval: interval });
  const warmPoolsQuery = useQuery({ queryKey: ["warm-pools"], queryFn: api.warmPools, enabled: capabilitiesQuery.data?.warmPools === true, refetchInterval: interval });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates, enabled: capabilitiesQuery.data?.templates === true, refetchInterval: interval });
  const problemsQuery = useQuery({ queryKey: ["problems"], queryFn: api.problems, refetchInterval: interval });
  const problemDagQuery = useQuery({ queryKey: ["problem-dag"], queryFn: api.problemDag, refetchInterval: interval });
  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: () => api.events(),
    enabled: capabilitiesQuery.data?.events === true,
    refetchInterval: interval,
  });
  const historyQuery = useQuery({
    queryKey: ["history-metrics"],
    queryFn: () => api.historyMetrics({ res: "15s" }),
    refetchInterval: 15_000,
  });
  const costSnapshotQuery = useQuery({
    queryKey: ["cost-snapshot"],
    queryFn: api.costSnapshot,
    refetchInterval: 30_000,
  });
  const controllerHealthQuery = useQuery({
    queryKey: ["controller-health"],
    queryFn: api.controllerHealth,
    enabled: capabilitiesQuery.data?.controllerHealth === true,
    refetchInterval: interval,
  });
  type QueryErrorEntry = { name: string; error: unknown };
  const queryErrors = ([
    capabilitiesQuery.isError ? { name: "capabilities", error: capabilitiesQuery.error } : null,
    sandboxesQuery.isError ? { name: "sandboxes", error: sandboxesQuery.error } : null,
    problemsQuery.isError ? { name: "problems", error: problemsQuery.error } : null,
    capabilitiesQuery.data?.claims === true && claimsQuery.isError ? { name: "claims", error: claimsQuery.error } : null,
    capabilitiesQuery.data?.warmPools === true && warmPoolsQuery.isError ? { name: "warm-pools", error: warmPoolsQuery.error } : null,
    capabilitiesQuery.data?.templates === true && templatesQuery.isError ? { name: "templates", error: templatesQuery.error } : null,
    capabilitiesQuery.data?.events === true && eventsQuery.isError ? { name: "events", error: eventsQuery.error } : null,
  ] as Array<QueryErrorEntry | null>).filter((entry): entry is QueryErrorEntry => entry !== null);

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

  // KPI overrides recomputed from the filtered live inventory so the strip
  // matches the OverviewSection below it when a namespace/search filter is
  // active. The history series is unscoped and would otherwise show
  // cluster-wide totals next to a namespace-scoped phase breakdown.
  const filterIsActive = filters.namespace !== "" || filters.search !== "" || filters.brokenOnly;
  const kpiOverride = useMemo(() => {
    if (!filterIsActive) return undefined;
    const warmPoolReady = filteredWarmPools.reduce((sum, pool) => sum + pool.readyReplicas, 0);
    const warmPoolDesired = filteredWarmPools.reduce((sum, pool) => sum + pool.desiredReplicas, 0);
    const failedPods =
      filteredSandboxes.filter((sandbox) => sandbox.objectState === "active" && sandbox.runtimeState === "missing").length +
      filteredClaims.filter((claim) => !claim.effectiveReady && claim.ageSeconds > 60).length;
    return {
      activeSandboxes: liveOverview.totals.activeSandboxes,
      pendingClaims: liveOverview.totals.pendingClaims,
      warmPoolFillRatio: warmPoolDesired > 0 ? warmPoolReady / warmPoolDesired : 0,
      failedPods,
    };
  }, [filterIsActive, filteredSandboxes, filteredClaims, filteredWarmPools, liveOverview]);

  const totalRawCount =
    (sandboxesQuery.data?.length ?? 0) +
    (claimsQuery.data?.length ?? 0) +
    (warmPoolsQuery.data?.length ?? 0) +
    (templatesQuery.data?.length ?? 0);
  const visibleCount =
    filteredSandboxes.length + filteredClaims.length + filteredWarmPools.length + filteredTemplates.length;
  const filterActive = visibleCount !== totalRawCount;

  // Apply the same namespace+search+broken filter to the problem list so the
  // status bar's "X errors · Y warnings" reflects the visible scope. The
  // /api/problems endpoint returns cluster-aggregate problems; without
  // filtering they include namespaces the user isn't currently looking at.
  const scopedProblems = useMemo(() => {
    return (problemsQuery.data ?? []).filter(
      (problem) =>
        matchesSearch(problem.resourceName, problem.namespace, filters.search) &&
        (!filters.namespace || problem.namespace === filters.namespace),
    );
  }, [problemsQuery.data, filters.search, filters.namespace]);
  const errorCount = scopedProblems.filter((problem) => problem.severity === "error").length;
  const warningCount = scopedProblems.filter((problem) => problem.severity === "warning").length;
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
  const costAvailable = costSnapshotQuery.data !== null && costSnapshotQuery.data !== undefined;

  return (
    <SidebarProvider>
      <AppSidebar
        view={view}
        onViewChange={(next) => {
          setView(next);
          if (next === "cost") filters.setView("cost");
          else if (next === "tenant") filters.setView("tenant");
          else if (next === "story") filters.setView("story");
          else filters.setView("operator");
        }}
        capabilities={capabilitiesQuery.data!}
        costAvailable={costAvailable}
        showTenant={identityQuery.data?.role === "tenant" || (identityQuery.data?.namespaces.length ?? 0) > 0}
      />
      <SidebarInset>
        <StatusBar
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
        <SavedViewsTabs />
        <TimeScrubber series={historyQuery.data ?? null} />
        <div className="flex-1 space-y-3 p-4 md:p-6">
          {view === "overview" && (
            <div className="space-y-3">
              <KpiStrip series={historyQuery.data ?? null} {...(kpiOverride ? { currentOverride: kpiOverride } : {})} />
              <OverviewSection overview={liveOverview} />
              <div className="grid gap-3 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)_minmax(280px,1fr)]">
                <ProblemsPanel problems={problemsQuery.data ?? []} dag={problemDagQuery.data ?? null} />
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
          {view !== "overview" && view !== "events" && view !== "cost" && view !== "tenant" && view !== "story" && (
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
          {view === "cost" && <CostView />}
          {view === "tenant" && identityQuery.data && <TenantView identity={identityQuery.data} />}
          {view === "story" && filters.drawer && (
            <SandboxStoryView
              namespace={filters.drawer.namespace}
              name={filters.drawer.resourceName}
              onClose={() => {
                filters.closeDrawer();
                setView("overview");
                filters.setView("operator");
              }}
            />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebar({
  view,
  onViewChange,
  capabilities,
  costAvailable,
  showTenant,
}: {
  view: View;
  onViewChange: (view: View) => void;
  capabilities: { claims: boolean; warmPools: boolean; templates: boolean; events: boolean };
  costAvailable: boolean;
  showTenant: boolean;
}) {
  const resources: Array<{ key: View; label: string; icon: typeof Boxes; enabled: boolean }> = [
    { key: "sandboxes", label: "Sandboxes", icon: Boxes, enabled: true },
    { key: "claims", label: "Claims", icon: FileText, enabled: capabilities.claims },
    { key: "warm-pools", label: "Warm pools", icon: Thermometer, enabled: capabilities.warmPools },
    { key: "templates", label: "Templates", icon: Layers, enabled: capabilities.templates },
  ];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-2">
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
        {(showTenant || costAvailable) && (
          <SidebarGroup>
            <SidebarGroupLabel>Lenses</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {showTenant && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={view === "tenant"}
                      onClick={() => onViewChange("tenant")}
                      tooltip="My team"
                    >
                      <User />
                      <span>My team</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {costAvailable && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={view === "cost"}
                      onClick={() => onViewChange("cost")}
                      tooltip="Cost"
                    >
                      <DollarSign />
                      <span>Cost</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
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
