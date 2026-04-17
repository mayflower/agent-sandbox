import { computeLiveOverview } from "@agent-sandbox/dashboard-shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "./lib/api.js";
import { FilterProvider, useFilters } from "./lib/filters.js";
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

function matchesName(name: string, namespace: string, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return name.toLowerCase().includes(needle) || namespace.toLowerCase().includes(needle);
}

function AppContent() {
  const filters = useFilters();
  const queryClient = useQueryClient();
  const capabilitiesQuery = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, refetchInterval: POLL_MS });
  const sandboxesQuery = useQuery({ queryKey: ["sandboxes"], queryFn: api.sandboxes, refetchInterval: POLL_MS });
  const claimsQuery = useQuery({ queryKey: ["claims"], queryFn: api.claims, enabled: capabilitiesQuery.data?.claims === true, refetchInterval: POLL_MS });
  const warmPoolsQuery = useQuery({ queryKey: ["warm-pools"], queryFn: api.warmPools, enabled: capabilitiesQuery.data?.warmPools === true, refetchInterval: POLL_MS });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates, enabled: capabilitiesQuery.data?.templates === true, refetchInterval: POLL_MS });
  const problemsQuery = useQuery({ queryKey: ["problems"], queryFn: api.problems, refetchInterval: POLL_MS });
  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: () => api.events(),
    enabled: capabilitiesQuery.data?.events === true,
    refetchInterval: POLL_MS,
  });
  const controllerHealthQuery = useQuery({
    queryKey: ["controller-health"],
    queryFn: api.controllerHealth,
    enabled: capabilitiesQuery.data?.controllerHealth === true,
    refetchInterval: POLL_MS,
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
        matchesName(sandbox.name, sandbox.namespace, filters.search) &&
        (!filters.namespace || sandbox.namespace === filters.namespace) &&
        (!filters.brokenOnly || !sandbox.effectiveReady),
    );
  }, [sandboxesQuery.data, filters.search, filters.namespace, filters.brokenOnly]);
  const filteredClaims = useMemo(() => {
    return (claimsQuery.data ?? []).filter(
      (claim) =>
        matchesName(claim.name, claim.namespace, filters.search) &&
        (!filters.namespace || claim.namespace === filters.namespace) &&
        (!filters.brokenOnly || !claim.effectiveReady || claim.readinessMismatch),
    );
  }, [claimsQuery.data, filters.search, filters.namespace, filters.brokenOnly]);
  const filteredWarmPools = useMemo(() => {
    return (warmPoolsQuery.data ?? []).filter(
      (pool) =>
        matchesName(pool.name, pool.namespace, filters.search) &&
        (!filters.namespace || pool.namespace === filters.namespace) &&
        (!filters.brokenOnly || pool.readyReplicas < pool.desiredReplicas),
    );
  }, [warmPoolsQuery.data, filters.search, filters.namespace, filters.brokenOnly]);

  const liveOverview = useMemo(
    () => computeLiveOverview(filteredSandboxes, filteredClaims, filteredWarmPools),
    [filteredSandboxes, filteredClaims, filteredWarmPools],
  );

  const updatedAt = Math.max(
    sandboxesQuery.dataUpdatedAt ?? 0,
    claimsQuery.dataUpdatedAt ?? 0,
    problemsQuery.dataUpdatedAt ?? 0,
  );
  const isFetching =
    sandboxesQuery.isFetching || problemsQuery.isFetching || claimsQuery.isFetching || warmPoolsQuery.isFetching;
  const refresh = () => queryClient.invalidateQueries();

  if (capabilitiesQuery.isLoading || sandboxesQuery.isLoading || problemsQuery.isLoading) {
    return <main className="flex min-h-screen items-center justify-center text-sm text-slate-700">Loading dashboard snapshot…</main>;
  }

  if (capabilitiesQuery.isError || sandboxesQuery.isError || problemsQuery.isError || hasOptionalQueryError) {
    return <main className="flex min-h-screen items-center justify-center text-sm text-rose-700">Dashboard snapshot failed to load.</main>;
  }

  return (
    <main className="surface-grid min-h-screen text-ink">
      <StatusBar
        problems={problemsQuery.data ?? []}
        namespaces={namespaces}
        updatedAt={updatedAt}
        onRefresh={refresh}
        isFetching={isFetching}
        controllerHealth={controllerHealthQuery.data ?? null}
      />
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-5 md:px-6">
        <OverviewSection overview={liveOverview} />

        <section aria-label="Problems and inventory" className="grid gap-4 xl:grid-cols-[minmax(320px,1fr)_2fr]">
          <ProblemsPanel problems={problemsQuery.data ?? []} />
          <div aria-label="Inventory">
            <InventorySection
              capabilities={capabilitiesQuery.data!}
              sandboxes={sandboxesQuery.data!}
              claims={claimsQuery.data ?? []}
              warmPools={warmPoolsQuery.data ?? []}
              templates={templatesQuery.data ?? []}
              events={eventsQuery.data ?? []}
            />
          </div>
        </section>

        <section aria-label="Capacity" className="grid gap-4 xl:grid-cols-[2fr_minmax(320px,1fr)]">
          <WarmPoolMatrix warmPools={filteredWarmPools} />
          <div className="space-y-4">
            <PendingClaimsByReason items={liveOverview.pendingClaimsByReason} />
            <EventsFeed events={eventsQuery.data ?? []} />
          </div>
        </section>
      </div>
    </main>
  );
}
