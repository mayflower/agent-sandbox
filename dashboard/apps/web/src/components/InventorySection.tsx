import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type {
  Capabilities,
  ClaimLiveView,
  EventView,
  SandboxLiveView,
  TemplateLiveView,
  WarmPoolLiveView,
} from "@agent-sandbox/dashboard-shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useFilters, type SandboxTarget } from "../lib/filters.js";
import { Badge } from "./ui/badge.js";
import { Card, CardTitle } from "./ui/card.js";
import { Drawer } from "./ui/drawer.js";
import { Progress } from "./ui/progress.js";
import { Tabs } from "./ui/tabs.js";
import { formatAge } from "../lib/utils.js";

type Selection =
  | {
      title: string;
      resourceKind: "Sandbox" | "SandboxClaim" | "SandboxWarmPool" | "SandboxTemplate";
      namespace: string;
      resourceName: string;
      body: ReactNode;
    }
  | null;

function tabKeyForKind(kind: SandboxTarget["resourceKind"]): string {
  switch (kind) {
    case "Sandbox":
      return "sandboxes";
    case "SandboxClaim":
      return "claims";
    case "SandboxWarmPool":
      return "warm-pools";
    case "SandboxTemplate":
      return "templates";
  }
}

function matchesSearch(name: string, namespace: string, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return name.toLowerCase().includes(needle) || namespace.toLowerCase().includes(needle);
}

function DataTable<T>({
  columns,
  data,
  onSelect,
  rowHighlight,
  emptyMessage,
}: {
  columns: ColumnDef<T>[];
  data: T[];
  onSelect: (row: T) => void;
  rowHighlight?: (row: T) => boolean;
  emptyMessage?: string;
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (data.length === 0) {
    return <p className="px-3 py-4 text-sm text-slate-600">{emptyMessage ?? "No matching resources."}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-y-2">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-3 py-2 text-left text-xs uppercase tracking-[0.2em] text-slate-500">
                  {header.isPlaceholder ? null : String(header.column.columnDef.header)}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const highlighted = rowHighlight?.(row.original) ?? false;
            return (
              <tr
                key={row.id}
                className={
                  "cursor-pointer rounded-2xl shadow-sm transition hover:bg-white " +
                  (highlighted ? "bg-rose-50/70 ring-1 ring-rose-200" : "bg-white/75")
                }
                onClick={() => onSelect(row.original)}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-3 text-sm text-slate-800">
                    {cell.column.columnDef.cell
                      ? flexRender(cell.column.columnDef.cell, cell.getContext())
                      : String(cell.getValue() ?? "")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EventList({ events }: { events: EventView[] }) {
  return (
    <section>
      <h3 className="mb-3 font-semibold text-slate-900">Events</h3>
      <div className="space-y-3">
        {events.length === 0 ? (
          <p className="text-sm text-slate-600">No events for this object.</p>
        ) : (
          events.map((event) => (
            <article
              key={`${event.resourceKind}-${event.resourceName}-${event.eventTime}-${event.reason}`}
              className="rounded-2xl border border-slate-200 bg-white/70 p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={event.type === "Warning" ? "warning" : "info"}>{event.type ?? "Info"}</Badge>
                <span className="font-semibold text-slate-800">{event.reason ?? "Event"}</span>
              </div>
              <p className="mt-2 text-sm text-slate-700">{event.message}</p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function InventorySection({
  capabilities,
  sandboxes,
  claims,
  warmPools,
  templates,
  events,
}: {
  capabilities: Capabilities;
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  warmPools: WarmPoolLiveView[];
  templates: TemplateLiveView[];
  events: EventView[];
}) {
  const filters = useFilters();
  const tabs = [
    { key: "sandboxes", label: "Sandboxes" },
    ...(capabilities.claims ? [{ key: "claims", label: "Claims" }] : []),
    ...(capabilities.warmPools ? [{ key: "warm-pools", label: "Warm Pools" }] : []),
    ...(capabilities.templates ? [{ key: "templates", label: "Templates" }] : []),
  ];
  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? "sandboxes");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [selected, setSelected] = useState<Selection>(null);

  const search = filters.search;
  const namespace = filters.namespace;
  const brokenOnly = filters.brokenOnly;

  const claimOf = useMemo(() => {
    const map = new Map<string, ClaimLiveView>();
    for (const claim of claims) {
      map.set(`${claim.namespace}/${claim.name}`, claim);
    }
    return map;
  }, [claims]);

  const filteredSandboxes = useMemo(
    () =>
      sandboxes.filter(
        (sandbox) =>
          matchesSearch(sandbox.name, sandbox.namespace, search) &&
          (!namespace || sandbox.namespace === namespace) &&
          (!ownerFilter || sandbox.ownerKind === ownerFilter) &&
          (!brokenOnly || !sandbox.effectiveReady),
      ),
    [sandboxes, search, namespace, ownerFilter, brokenOnly],
  );
  const filteredClaims = useMemo(
    () =>
      claims.filter(
        (claim) =>
          matchesSearch(claim.name, claim.namespace, search) &&
          (!namespace || claim.namespace === namespace) &&
          (!brokenOnly || !claim.effectiveReady || claim.readinessMismatch),
      ),
    [claims, search, namespace, brokenOnly],
  );
  const filteredWarmPools = useMemo(
    () =>
      warmPools.filter(
        (warmPool) =>
          matchesSearch(warmPool.name, warmPool.namespace, search) &&
          (!namespace || warmPool.namespace === namespace) &&
          (!brokenOnly || warmPool.readyReplicas < warmPool.desiredReplicas),
      ),
    [warmPools, search, namespace, brokenOnly],
  );
  const filteredTemplates = useMemo(
    () =>
      templates.filter(
        (template) =>
          matchesSearch(template.name, template.namespace, search) &&
          (!namespace || template.namespace === namespace),
      ),
    [templates, search, namespace],
  );

  const sandboxColumns = useMemo<ColumnDef<SandboxLiveView>[]>(
    () => [
      { header: "Name", accessorKey: "name" },
      { header: "Namespace", accessorKey: "namespace" },
      { header: "Template", accessorFn: (sandbox) => sandbox.templateRef ?? "—" },
      { header: "Owner", accessorKey: "ownerKind" },
      {
        header: "State",
        accessorKey: "runtimeState",
        cell: ({ row }) => (
          <Badge tone={row.original.effectiveReady ? "success" : row.original.runtimeState === "missing" ? "danger" : "warning"}>
            {row.original.effectiveReady ? "ready" : row.original.runtimeState}
          </Badge>
        ),
      },
      { header: "Age", accessorFn: (sandbox) => formatAge(sandbox.ageSeconds) },
    ],
    [],
  );
  const claimColumns = useMemo<ColumnDef<ClaimLiveView>[]>(
    () => [
      { header: "Name", accessorKey: "name" },
      { header: "Namespace", accessorKey: "namespace" },
      { header: "Template", accessorKey: "templateRef" },
      { header: "Sandbox", accessorFn: (claim) => claim.sandboxName ?? "—" },
      {
        header: "State",
        accessorKey: "state",
        cell: ({ row }) => (
          <Badge tone={row.original.effectiveReady ? "success" : "warning"}>{row.original.state}</Badge>
        ),
      },
      {
        header: "Mismatch",
        accessorFn: (claim) => (claim.readinessMismatch ? "yes" : "no"),
      },
    ],
    [],
  );
  const warmPoolColumns = useMemo<ColumnDef<WarmPoolLiveView>[]>(
    () => [
      { header: "Name", accessorKey: "name" },
      { header: "Template", accessorKey: "templateRef" },
      { header: "Ready", accessorKey: "readyReplicas" },
      { header: "Desired", accessorKey: "desiredReplicas" },
      {
        header: "Fill",
        accessorFn: (warmPool) => `${Math.round(warmPool.fillRatio * 100)}%`,
        cell: ({ row }) => (
          <Badge
            tone={row.original.readyReplicas < row.original.desiredReplicas ? "warning" : "success"}
          >
            {Math.round(row.original.fillRatio * 100)}%
          </Badge>
        ),
      },
    ],
    [],
  );
  const templateColumns = useMemo<ColumnDef<TemplateLiveView>[]>(
    () => [
      { header: "Name", accessorKey: "name" },
      { header: "Network", accessorKey: "networkPolicyMode" },
      {
        header: "Automount",
        accessorFn: (template) => (template.automountServiceAccountTokenDefaultFalse ? "default false" : "enabled"),
      },
      { header: "Claims", accessorKey: "activeClaims" },
      { header: "Sandboxes", accessorKey: "activeSandboxes" },
      { header: "Warm Pools", accessorKey: "activeWarmPools" },
    ],
    [],
  );

  const openSandbox = (sandbox: SandboxLiveView) => {
    const claim = sandbox.claimName ? claimOf.get(`${sandbox.namespace}/${sandbox.claimName}`) : undefined;
    setSelected({
      title: sandbox.name,
      namespace: sandbox.namespace,
      resourceKind: "Sandbox",
      resourceName: sandbox.name,
      body: (
        <div className="space-y-4">
          <section>
            <h3 className="font-semibold text-slate-900">Status</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={sandbox.effectiveReady ? "success" : "warning"}>
                {sandbox.effectiveReady ? "ready" : "not ready"}
              </Badge>
              <Badge tone="info">{sandbox.objectState}</Badge>
              <Badge tone="neutral">{sandbox.runtimeState}</Badge>
              <Badge tone="neutral">age {formatAge(sandbox.ageSeconds)}</Badge>
            </div>
          </section>
          <section>
            <h3 className="font-semibold text-slate-900">Runtime</h3>
            <p className="mt-2 text-sm text-slate-700">
              Pod {sandbox.podName ?? "missing"}
              {sandbox.podPhase ? ` (${sandbox.podPhase})` : ""} on {sandbox.nodeName ?? "n/a"}
              {" · "}
              IPs: {sandbox.podIPs.join(", ") || "none"}
            </p>
          </section>
          <section>
            <h3 className="font-semibold text-slate-900">Owner</h3>
            <p className="mt-2 text-sm text-slate-700">
              {sandbox.ownerKind === "direct" && "Standalone (no claim / no warm pool)"}
              {sandbox.ownerKind === "claim" && `SandboxClaim ${sandbox.claimName ?? "?"}`}
              {sandbox.ownerKind === "warm-pool" && `SandboxWarmPool ${sandbox.warmPoolName ?? "?"}`}
            </p>
            {claim && (
              <p className="mt-1 text-sm text-slate-600">
                Claim state: <Badge tone={claim.effectiveReady ? "success" : "warning"}>{claim.state}</Badge>
                {claim.readinessMismatch && <span className="ml-2 text-xs text-amber-700">readiness mismatch</span>}
              </p>
            )}
          </section>
          <section>
            <h3 className="font-semibold text-slate-900">Template &amp; storage</h3>
            <p className="mt-2 text-sm text-slate-700">Template {sandbox.templateRef ?? "n/a"}.</p>
            <p className="mt-1 text-sm text-slate-700">
              PVCs: {sandbox.pvcNames.length > 0 ? sandbox.pvcNames.join(", ") : "none attached"}
            </p>
          </section>
          <section>
            <h3 className="font-semibold text-slate-900">kubectl</h3>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              kubectl describe sandbox {sandbox.name} -n {sandbox.namespace}
            </pre>
          </section>
        </div>
      ),
    });
  };

  const openClaim = (claim: ClaimLiveView) => {
    setSelected({
      title: claim.name,
      namespace: claim.namespace,
      resourceKind: "SandboxClaim",
      resourceName: claim.name,
      body: (
        <div className="space-y-4">
          <section>
            <h3 className="font-semibold text-slate-900">Claim</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={claim.readinessMismatch ? "warning" : "success"}>
                {claim.readinessMismatch ? "mismatch" : "aligned"}
              </Badge>
              <Badge tone="neutral">{claim.state}</Badge>
              <Badge tone="neutral">age {formatAge(claim.ageSeconds)}</Badge>
            </div>
          </section>
          <section>
            <h3 className="font-semibold text-slate-900">Sandbox</h3>
            <p className="mt-2 text-sm text-slate-700">
              Sandbox {claim.sandboxName ?? "pending"} · IPs: {claim.podIPs.join(", ") || "none"}
            </p>
          </section>
          {claim.rawReadyCondition && (
            <section>
              <h3 className="font-semibold text-slate-900">Ready condition</h3>
              <p className="mt-2 text-sm text-slate-700">
                status={claim.rawReadyCondition.status}
                {claim.rawReadyCondition.reason && ` · reason=${claim.rawReadyCondition.reason}`}
                {claim.rawReadyCondition.message && ` · ${claim.rawReadyCondition.message}`}
              </p>
            </section>
          )}
        </div>
      ),
    });
  };

  const openWarmPool = (warmPool: WarmPoolLiveView) => {
    setSelected({
      title: warmPool.name,
      namespace: warmPool.namespace,
      resourceKind: "SandboxWarmPool",
      resourceName: warmPool.name,
      body: (
        <div className="space-y-4">
          <section>
            <h3 className="font-semibold text-slate-900">Capacity</h3>
            <div className="mt-2">
              <Progress value={warmPool.fillRatio} />
            </div>
            <p className="mt-1 text-xs text-slate-600">
              {warmPool.readyReplicas} ready of {warmPool.desiredReplicas} desired · template {warmPool.templateRef}
            </p>
          </section>
          <section>
            <h3 className="font-semibold text-slate-900">Members</h3>
            {warmPool.memberSandboxes.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No member sandboxes.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {warmPool.memberSandboxes.map((member) => (
                  <li key={member.name} className="flex items-center gap-2">
                    <Badge tone={member.ready ? "success" : "warning"}>{member.ready ? "ready" : "not ready"}</Badge>
                    <span className="truncate">{member.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ),
    });
  };

  const openTemplate = (template: TemplateLiveView) => {
    setSelected({
      title: template.name,
      namespace: template.namespace,
      resourceKind: "SandboxTemplate",
      resourceName: template.name,
      body: (
        <div className="space-y-4">
          <section>
            <h3 className="font-semibold text-slate-900">Posture</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="info">{template.networkPolicyMode}</Badge>
              <Badge tone={template.automountServiceAccountTokenDefaultFalse ? "success" : "warning"}>
                {template.automountServiceAccountTokenDefaultFalse ? "default false posture" : "automount enabled"}
              </Badge>
            </div>
          </section>
          <section>
            <h3 className="font-semibold text-slate-900">Usage</h3>
            <p className="mt-2 text-sm text-slate-700">
              {template.activeSandboxes} sandbox{template.activeSandboxes === 1 ? "" : "es"} ·{" "}
              {template.activeClaims} claim{template.activeClaims === 1 ? "" : "s"} ·{" "}
              {template.activeWarmPools} warm pool{template.activeWarmPools === 1 ? "" : "s"}
            </p>
          </section>
        </div>
      ),
    });
  };

  useEffect(() => {
    const target = filters.target;
    if (!target) return;
    const desiredTab = tabKeyForKind(target.resourceKind);
    if (tabs.some((tab) => tab.key === desiredTab)) {
      setActiveTab(desiredTab);
    }
    if (target.resourceKind === "Sandbox") {
      const match = sandboxes.find((sandbox) => sandbox.namespace === target.namespace && sandbox.name === target.resourceName);
      if (match) openSandbox(match);
    } else if (target.resourceKind === "SandboxClaim") {
      const match = claims.find((claim) => claim.namespace === target.namespace && claim.name === target.resourceName);
      if (match) openClaim(match);
    } else if (target.resourceKind === "SandboxWarmPool") {
      const match = warmPools.find((warmPool) => warmPool.namespace === target.namespace && warmPool.name === target.resourceName);
      if (match) openWarmPool(match);
    } else if (target.resourceKind === "SandboxTemplate") {
      const match = templates.find((template) => template.namespace === target.namespace && template.name === target.resourceName);
      if (match) openTemplate(match);
    }
    filters.clearTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.target]);

  const selectedEvents = selected
    ? events.filter(
        (event) =>
          event.namespace === selected.namespace &&
          event.resourceKind === selected.resourceKind &&
          event.resourceName === selected.resourceName,
      )
    : [];

  return (
    <Card>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <CardTitle>Inventory</CardTitle>
            <p className="mt-1 text-sm text-slate-600">
              Search, filter, and drill into sandboxes, claims, warm pools, and templates.
            </p>
          </div>
          <Tabs active={activeTab} onChange={setActiveTab} tabs={tabs} />
        </div>

        {activeTab === "sandboxes" && (
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              <div className="mb-1 font-semibold text-slate-700">Owner kind</div>
              <select
                className="w-full rounded-2xl border border-slate-300 px-3 py-2"
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
              >
                <option value="">all</option>
                <option value="direct">direct</option>
                <option value="claim">claim</option>
                <option value="warm-pool">warm-pool</option>
              </select>
            </label>
          </div>
        )}

        {activeTab === "sandboxes" && (
          <DataTable
            columns={sandboxColumns}
            data={filteredSandboxes}
            onSelect={openSandbox}
            rowHighlight={(sandbox) => !sandbox.effectiveReady}
            emptyMessage={brokenOnly ? "No broken sandboxes match." : "No sandboxes match."}
          />
        )}

        {activeTab === "claims" && (
          <DataTable
            columns={claimColumns}
            data={filteredClaims}
            onSelect={openClaim}
            rowHighlight={(claim) => !claim.effectiveReady || claim.readinessMismatch}
            emptyMessage={brokenOnly ? "No broken claims." : "No claims match."}
          />
        )}

        {activeTab === "warm-pools" && (
          <DataTable
            columns={warmPoolColumns}
            data={filteredWarmPools}
            onSelect={openWarmPool}
            rowHighlight={(warmPool) => warmPool.readyReplicas < warmPool.desiredReplicas}
            emptyMessage={brokenOnly ? "No underfilled warm pools." : "No warm pools match."}
          />
        )}

        {activeTab === "templates" && (
          <DataTable
            columns={templateColumns}
            data={filteredTemplates}
            onSelect={openTemplate}
            emptyMessage="No templates match."
          />
        )}
      </div>

      <Drawer open={selected !== null} title={selected?.title ?? ""} onClose={() => setSelected(null)}>
        {selected?.body}
        <EventList events={selectedEvents} />
      </Drawer>
    </Card>
  );
}
