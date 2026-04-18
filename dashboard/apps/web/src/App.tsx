import { computeLiveOverview } from "@agent-sandbox/dashboard-shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { api } from "./lib/api.js";
import { FilterProvider, useFilters } from "./lib/filters.js";
import { useTheme } from "./lib/useTheme.js";
import { matchesSearch } from "./lib/utils.js";
import { EventsFeed } from "./components/EventsFeed.js";
import { InventorySection } from "./components/InventorySection.js";
import { OverviewSection } from "./components/OverviewSection.js";
import { PendingClaimsByReason } from "./components/PendingClaimsByReason.js";
import { ProblemsPanel } from "./components/ProblemsPanel.js";
import { StatusBar } from "./components/StatusBar.js";
import { WarmPoolMatrix } from "./components/WarmPoolMatrix.js";

const POLL_MS = 5000;

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
  const interval: number | false = paused ? false : POLL_MS;
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
  const hasOptionalQueryError =
    (capabilitiesQuery.data?.claims === true && claimsQuery.isError) ||
    (capabilitiesQuery.data?.warmPools === true && warmPoolsQuery.isError) ||
    (capabilitiesQuery.data?.templates === true && templatesQuery.isError) ||
    (capabilitiesQuery.data?.events === true && eventsQuery.isError);

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

  const updatedAt = Math.max(
    sandboxesQuery.dataUpdatedAt ?? 0,
    claimsQuery.dataUpdatedAt ?? 0,
    problemsQuery.dataUpdatedAt ?? 0,
  );
  const isFetching =
    sandboxesQuery.isFetching || problemsQuery.isFetching || claimsQuery.isFetching || warmPoolsQuery.isFetching;
  const refresh = () => queryClient.invalidateQueries();

  if (capabilitiesQuery.isLoading || sandboxesQuery.isLoading || problemsQuery.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-600 dark:text-slate-400">
        Loading dashboard snapshot…
      </main>
    );
  }

  if (capabilitiesQuery.isError || sandboxesQuery.isError || problemsQuery.isError || hasOptionalQueryError) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-rose-700 dark:text-rose-300">
        Dashboard snapshot failed to load.
      </main>
    );
  }

  return (
    <main className="surface-grid min-h-screen text-ink dark:text-slate-100">
      <StatusBar
        problems={problemsQuery.data ?? []}
        namespaces={namespaces}
        updatedAt={updatedAt}
        onRefresh={refresh}
        isFetching={isFetching}
        controllerHealth={controllerHealthQuery.data ?? null}
        paused={paused}
        onTogglePause={() => setPaused((prev) => !prev)}
        theme={theme}
        onToggleTheme={toggleTheme}
        resultCount={visibleCount}
        totalCount={totalRawCount}
      />
      <div className="mx-auto max-w-[96rem] space-y-2 px-4 py-3 md:px-6">
        <OverviewSection overview={liveOverview} />

        <section
          aria-label="Triage"
          className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-[minmax(300px,1fr)_minmax(0,2fr)_minmax(300px,1fr)]"
        >
          <ProblemsPanel problems={problemsQuery.data ?? []} />
          <div aria-label="Inventory" className="2xl:col-auto lg:col-span-2">
            <InventorySection
              capabilities={capabilitiesQuery.data!}
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
          </div>
          <div className="space-y-2">
            <WarmPoolMatrix warmPools={filteredWarmPools} />
            <PendingClaimsByReason items={liveOverview.pendingClaimsByReason} />
            <EventsFeed events={eventsQuery.data ?? []} />
          </div>
        </section>
      </div>
    </main>
  );
}
