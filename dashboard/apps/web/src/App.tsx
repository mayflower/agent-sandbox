import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "./lib/api.js";
import { FilterProvider } from "./lib/filters.js";
import { InventorySection } from "./components/InventorySection.js";
import { OverviewSection } from "./components/OverviewSection.js";
import { ProblemsPanel } from "./components/ProblemsPanel.js";
import { StatusBar } from "./components/StatusBar.js";

const POLL_MS = 5000;

export default function App() {
  return (
    <FilterProvider>
      <AppContent />
    </FilterProvider>
  );
}

function AppContent() {
  const queryClient = useQueryClient();
  const capabilitiesQuery = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, refetchInterval: POLL_MS });
  const overviewQuery = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: POLL_MS });
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

  const updatedAt = Math.max(
    overviewQuery.dataUpdatedAt ?? 0,
    sandboxesQuery.dataUpdatedAt ?? 0,
    problemsQuery.dataUpdatedAt ?? 0,
  );
  const isFetching =
    overviewQuery.isFetching || sandboxesQuery.isFetching || problemsQuery.isFetching || claimsQuery.isFetching || warmPoolsQuery.isFetching;
  const refresh = () => queryClient.invalidateQueries();

  if (capabilitiesQuery.isLoading || overviewQuery.isLoading || sandboxesQuery.isLoading || problemsQuery.isLoading) {
    return <main className="flex min-h-screen items-center justify-center text-lg text-stone-700">Loading dashboard snapshot…</main>;
  }

  if (capabilitiesQuery.isError || overviewQuery.isError || sandboxesQuery.isError || problemsQuery.isError || hasOptionalQueryError) {
    return <main className="flex min-h-screen items-center justify-center text-lg text-rose-700">Dashboard snapshot failed to load.</main>;
  }

  return (
    <main className="surface-grid min-h-screen text-ink">
      <StatusBar
        problems={problemsQuery.data ?? []}
        namespaces={namespaces}
        updatedAt={updatedAt}
        onRefresh={refresh}
        isFetching={isFetching}
      />
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 md:px-8">
        <OverviewSection overview={overviewQuery.data!} warmPools={warmPoolsQuery.data ?? []} />

        <section aria-label="Problems and inventory" className="grid gap-5 xl:grid-cols-[1.05fr_2fr]">
          <ProblemsPanel problems={problemsQuery.data ?? []} />
          <div aria-label="Inventory" className="space-y-4">
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
      </div>
    </main>
  );
}
