import { useQuery } from "@tanstack/react-query";

import { api } from "./lib/api.js";
import { InventorySection } from "./components/InventorySection.js";
import { OverviewSection } from "./components/OverviewSection.js";
import { ProblemsPanel } from "./components/ProblemsPanel.js";

export default function App() {
  const capabilitiesQuery = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities });
  const overviewQuery = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const sandboxesQuery = useQuery({ queryKey: ["sandboxes"], queryFn: api.sandboxes });
  const claimsQuery = useQuery({ queryKey: ["claims"], queryFn: api.claims, enabled: capabilitiesQuery.data?.claims === true });
  const warmPoolsQuery = useQuery({ queryKey: ["warm-pools"], queryFn: api.warmPools, enabled: capabilitiesQuery.data?.warmPools === true });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates, enabled: capabilitiesQuery.data?.templates === true });
  const problemsQuery = useQuery({ queryKey: ["problems"], queryFn: api.problems });
  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: () => api.events(),
    enabled: capabilitiesQuery.data?.events === true,
  });
  const hasOptionalQueryError =
    (capabilitiesQuery.data?.claims === true && claimsQuery.isError) ||
    (capabilitiesQuery.data?.warmPools === true && warmPoolsQuery.isError) ||
    (capabilitiesQuery.data?.templates === true && templatesQuery.isError) ||
    (capabilitiesQuery.data?.events === true && eventsQuery.isError);

  if (capabilitiesQuery.isLoading || overviewQuery.isLoading || sandboxesQuery.isLoading || problemsQuery.isLoading) {
    return <main className="flex min-h-screen items-center justify-center text-lg text-stone-700">Loading dashboard snapshot…</main>;
  }

  if (capabilitiesQuery.isError || overviewQuery.isError || sandboxesQuery.isError || problemsQuery.isError || hasOptionalQueryError) {
    return <main className="flex min-h-screen items-center justify-center text-lg text-rose-700">Dashboard snapshot failed to load.</main>;
  }

  return (
    <main className="surface-grid min-h-screen px-4 py-8 text-ink md:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-[2rem] border border-emerald-200/80 bg-panel/90 px-6 py-8 shadow-panel">
          <p className="text-xs uppercase tracking-[0.32em] text-accent">Live Snapshot</p>
          <h1 className="mt-3 font-display text-5xl text-ink">Agent Sandbox Dashboard</h1>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-stone-700">
            Read-only cluster state for sandboxes, extension claims, warm pools, templates, and active problems.
          </p>
        </header>

        <section aria-label="Overview" className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-3xl">Overview</h2>
            <span className="rounded-full border border-accent/30 bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-accent">
              no history
            </span>
          </div>
          <OverviewSection overview={overviewQuery.data!} />
        </section>

        <section aria-label="Problems and inventory" className="grid gap-6 xl:grid-cols-[1.05fr_2fr]">
          <ProblemsPanel problems={problemsQuery.data!} />
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
