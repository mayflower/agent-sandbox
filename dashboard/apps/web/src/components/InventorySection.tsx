import { flexRender, getCoreRowModel, getPaginationRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type {
  Capabilities,
  ClaimLiveView,
  EventView,
  SandboxLiveView,
  SandboxResourceKind,
  TemplateLiveView,
  WarmPoolLiveView,
} from "@agent-sandbox/dashboard-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../lib/api.js";
import { useFilters } from "../lib/filters.js";
import { ActionButton } from "./ActionButton.js";
import { Badge } from "./ui/badge.js";
import { Card, CardTitle } from "./ui/card.js";
import { Drawer } from "./ui/drawer.js";
import { Progress } from "./ui/progress.js";
import { Tabs } from "./ui/tabs.js";
import { formatAge } from "../lib/utils.js";

type Selection =
  | {
      title: string;
      resourceKind: SandboxResourceKind;
      namespace: string;
      resourceName: string;
      body: ReactNode;
    }
  | null;

function tabKeyForKind(kind: SandboxResourceKind): string {
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

function SandboxActions({ sandbox }: { sandbox: SandboxLiveView }) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries();
  const del = useMutation({
    mutationFn: () => api.deleteSandbox(sandbox.namespace, sandbox.name),
    onSuccess,
  });
  const reconcile = useMutation({
    mutationFn: () => api.reconcileSandbox(sandbox.namespace, sandbox.name),
    onSuccess,
  });

  const ORPHAN_MIN_AGE = 600;
  const canDelete =
    (sandbox.runtimeState === "missing" && sandbox.ageSeconds >= ORPHAN_MIN_AGE) ||
    sandbox.objectState === "expired" ||
    sandbox.objectState === "retained";
  const deleteReason = canDelete
    ? sandbox.runtimeState === "missing"
      ? "Pod missing; sandbox is orphaned."
      : `Object state is ${sandbox.objectState}.`
    : "Not eligible: runtime still present and sandbox is active.";

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Actions</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ActionButton
          label="Delete sandbox"
          confirmLabel="Confirm delete"
          tone="danger"
          disabled={!canDelete}
          pending={del.isPending}
          onConfirm={() => del.mutateAsync()}
        />
        <ActionButton
          label="Retry reconcile"
          confirmLabel="Confirm reconcile"
          pending={reconcile.isPending}
          onConfirm={() => reconcile.mutateAsync()}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {deleteReason} Reconcile bumps an annotation; always safe.
      </p>
    </section>
  );
}

function ClaimActions({ claim, templateMissing }: { claim: ClaimLiveView; templateMissing: boolean }) {
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteClaim(claim.namespace, claim.name),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Actions</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ActionButton
          label="Delete claim"
          confirmLabel="Confirm delete"
          tone="danger"
          disabled={!templateMissing}
          pending={del.isPending}
          onConfirm={() => del.mutateAsync()}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {templateMissing
          ? `Template "${claim.templateRef}" is not present; safe to delete.`
          : "Template exists; dashboard only deletes claims whose template is missing."}
      </p>
    </section>
  );
}

const PAGE_SIZE = 15;

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
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  if (data.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-slate-500 dark:text-slate-400">
        {emptyMessage ?? "No matching resources."}
      </p>
    );
  }

  const totalRows = data.length;
  const pageIndex = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();
  const rangeStart = pageIndex * PAGE_SIZE + 1;
  const rangeEnd = Math.min(rangeStart + PAGE_SIZE - 1, totalRows);

  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="border-b border-slate-200 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:text-slate-400"
                  >
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
                    "cursor-pointer border-b border-slate-100 text-xs transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800 " +
                    (highlighted ? "bg-rose-50/60 dark:bg-rose-900/20" : "")
                  }
                  onClick={() => onSelect(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-2 py-1 text-slate-800 dark:text-slate-200"
                    >
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
      {pageCount > 1 && (
        <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-1.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <span className="tabular-nums">
            {rangeStart}–{rangeEnd} of {totalRows}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              ‹
            </button>
            <span className="px-1 tabular-nums">
              {pageIndex + 1}/{pageCount}
            </span>
            <button
              type="button"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EventList({ events }: { events: EventView[] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Events</h3>
      <div className="space-y-1.5">
        {events.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">No events for this object.</p>
        ) : (
          events.map((event) => (
            <article
              key={`${event.resourceKind}-${event.resourceName}-${event.eventTime}-${event.reason}`}
              className="rounded border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={event.type === "Warning" ? "warning" : "info"} dot>
                  {event.reason ?? event.type ?? "Event"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">{event.message}</p>
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
  rawSandboxes,
  rawClaims,
  rawWarmPools,
  rawTemplates,
  events,
}: {
  capabilities: Capabilities;
  sandboxes: SandboxLiveView[];
  claims: ClaimLiveView[];
  warmPools: WarmPoolLiveView[];
  templates: TemplateLiveView[];
  rawSandboxes: SandboxLiveView[];
  rawClaims: ClaimLiveView[];
  rawWarmPools: WarmPoolLiveView[];
  rawTemplates: TemplateLiveView[];
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

  const brokenOnly = filters.brokenOnly;

  const claimOf = useMemo(() => {
    const map = new Map<string, ClaimLiveView>();
    for (const claim of claims) {
      map.set(`${claim.namespace}/${claim.name}`, claim);
    }
    return map;
  }, [claims]);

  const templatePresence = useMemo(() => {
    const set = new Set<string>();
    for (const template of rawTemplates) {
      set.add(`${template.namespace}/${template.name}`);
    }
    return set;
  }, [rawTemplates]);

  const filteredSandboxes = useMemo(
    () => (ownerFilter ? sandboxes.filter((sandbox) => sandbox.ownerKind === ownerFilter) : sandboxes),
    [sandboxes, ownerFilter],
  );

  const showTemplateColumn = useMemo(() => {
    if (rawSandboxes.length === 0) return true;
    const mapped = rawSandboxes.filter((sandbox) => sandbox.templateRef).length;
    return mapped / rawSandboxes.length >= 0.2;
  }, [rawSandboxes]);

  const sandboxColumns = useMemo<ColumnDef<SandboxLiveView>[]>(
    () => {
      const columns: ColumnDef<SandboxLiveView>[] = [
        {
          header: "Name",
          accessorKey: "name",
          cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
        },
        { header: "Namespace", accessorKey: "namespace" },
      ];
      if (showTemplateColumn) {
        columns.push({ header: "Template", accessorFn: (sandbox) => sandbox.templateRef ?? "—" });
      }
      columns.push(
        { header: "Owner", accessorKey: "ownerKind" },
        {
          header: "State",
          accessorKey: "runtimeState",
          cell: ({ row }) => (
            <Badge
              tone={
                row.original.effectiveReady
                  ? "success"
                  : row.original.runtimeState === "missing"
                    ? "danger"
                    : "warning"
              }
              dot
            >
              {row.original.effectiveReady ? "ready" : row.original.runtimeState}
            </Badge>
          ),
        },
        { header: "Age", accessorFn: (sandbox) => formatAge(sandbox.ageSeconds) },
      );
      return columns;
    },
    [showTemplateColumn],
  );
  const claimColumns = useMemo<ColumnDef<ClaimLiveView>[]>(
    () => [
      {
        header: "Name",
        accessorKey: "name",
        cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
      },
      { header: "Namespace", accessorKey: "namespace" },
      { header: "Template", accessorKey: "templateRef" },
      { header: "Sandbox", accessorFn: (claim) => claim.sandboxName ?? "—" },
      {
        header: "State",
        accessorKey: "state",
        cell: ({ row }) => (
          <Badge tone={row.original.effectiveReady ? "success" : "warning"} dot>
            {row.original.state}
          </Badge>
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
      {
        header: "Name",
        accessorKey: "name",
        cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
      },
      { header: "Template", accessorKey: "templateRef" },
      { header: "Ready", accessorKey: "readyReplicas" },
      { header: "Desired", accessorKey: "desiredReplicas" },
      {
        header: "Fill",
        accessorFn: (warmPool) => `${Math.round(warmPool.fillRatio * 100)}%`,
        cell: ({ row }) => (
          <Badge
            tone={row.original.readyReplicas < row.original.desiredReplicas ? "warning" : "success"}
            dot
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
      {
        header: "Name",
        accessorKey: "name",
        cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
      },
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Status</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={sandbox.effectiveReady ? "success" : "warning"} dot>
                {sandbox.effectiveReady ? "ready" : "not ready"}
              </Badge>
              <Badge tone="info">{sandbox.objectState}</Badge>
              <Badge tone="neutral">{sandbox.runtimeState}</Badge>
              <Badge tone="neutral">age {formatAge(sandbox.ageSeconds)}</Badge>
            </div>
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Runtime</h3>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              Pod {sandbox.podName ?? "missing"}
              {sandbox.podPhase ? ` (${sandbox.podPhase})` : ""} on {sandbox.nodeName ?? "n/a"}
              {" · "}
              IPs: {sandbox.podIPs.join(", ") || "none"}
            </p>
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Owner</h3>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              {sandbox.ownerKind === "direct" && "Standalone (no claim / no warm pool)"}
              {sandbox.ownerKind === "claim" && `SandboxClaim ${sandbox.claimName ?? "?"}`}
              {sandbox.ownerKind === "warm-pool" && `SandboxWarmPool ${sandbox.warmPoolName ?? "?"}`}
            </p>
            {claim && (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Claim state: <Badge tone={claim.effectiveReady ? "success" : "warning"}>{claim.state}</Badge>
                {claim.readinessMismatch && <span className="ml-2 text-xs text-amber-700">readiness mismatch</span>}
              </p>
            )}
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Template &amp; storage</h3>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">Template {sandbox.templateRef ?? "n/a"}.</p>
            <p className="mt-1 text-sm text-slate-700">
              PVCs: {sandbox.pvcNames.length > 0 ? sandbox.pvcNames.join(", ") : "none attached"}
            </p>
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">kubectl</h3>
            <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100 dark:bg-slate-950">
              kubectl describe sandbox {sandbox.name} -n {sandbox.namespace}
            </pre>
          </section>
          <SandboxActions sandbox={sandbox} />
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Claim</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={claim.readinessMismatch ? "warning" : "success"}>
                {claim.readinessMismatch ? "mismatch" : "aligned"}
              </Badge>
              <Badge tone="neutral">{claim.state}</Badge>
              <Badge tone="neutral">age {formatAge(claim.ageSeconds)}</Badge>
            </div>
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Sandbox</h3>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              Sandbox {claim.sandboxName ?? "pending"} · IPs: {claim.podIPs.join(", ") || "none"}
            </p>
          </section>
          {claim.rawReadyCondition && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Ready condition</h3>
              <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
                status={claim.rawReadyCondition.status}
                {claim.rawReadyCondition.reason && ` · reason=${claim.rawReadyCondition.reason}`}
                {claim.rawReadyCondition.message && ` · ${claim.rawReadyCondition.message}`}
              </p>
            </section>
          )}
          <ClaimActions
            claim={claim}
            templateMissing={!templatePresence.has(`${claim.namespace}/${claim.templateRef}`)}
          />
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Capacity</h3>
            <div className="mt-2">
              <Progress value={warmPool.fillRatio} />
            </div>
            <p className="mt-1 text-xs text-slate-600">
              {warmPool.readyReplicas} ready of {warmPool.desiredReplicas} desired · template {warmPool.templateRef}
            </p>
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Members</h3>
            {warmPool.memberSandboxes.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">No member sandboxes.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-300">
                {warmPool.memberSandboxes.map((member) => (
                  <li key={member.name} className="flex items-center gap-2">
                    <Badge tone={member.ready ? "success" : "warning"} dot>
                      {member.ready ? "ready" : "not ready"}
                    </Badge>
                    <span className="truncate font-mono text-xs">{member.name}</span>
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Posture</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="info">{template.networkPolicyMode}</Badge>
              <Badge tone={template.automountServiceAccountTokenDefaultFalse ? "success" : "warning"}>
                {template.automountServiceAccountTokenDefaultFalse ? "default false posture" : "automount enabled"}
              </Badge>
            </div>
          </section>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Usage</h3>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
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
      const match = rawSandboxes.find((sandbox) => sandbox.namespace === target.namespace && sandbox.name === target.resourceName);
      if (match) openSandbox(match);
    } else if (target.resourceKind === "SandboxClaim") {
      const match = rawClaims.find((claim) => claim.namespace === target.namespace && claim.name === target.resourceName);
      if (match) openClaim(match);
    } else if (target.resourceKind === "SandboxWarmPool") {
      const match = rawWarmPools.find((warmPool) => warmPool.namespace === target.namespace && warmPool.name === target.resourceName);
      if (match) openWarmPool(match);
    } else if (target.resourceKind === "SandboxTemplate") {
      const match = rawTemplates.find((template) => template.namespace === target.namespace && template.name === target.resourceName);
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
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Inventory</CardTitle>
          {activeTab === "sandboxes" && (
            <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              owner
              <select
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 focus:border-sky-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
              >
                <option value="">all</option>
                <option value="direct">direct</option>
                <option value="claim">claim</option>
                <option value="warm-pool">warm-pool</option>
              </select>
            </label>
          )}
        </div>
        <Tabs active={activeTab} onChange={setActiveTab} tabs={tabs} />

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
            data={claims}
            onSelect={openClaim}
            rowHighlight={(claim) => !claim.effectiveReady || claim.readinessMismatch}
            emptyMessage={brokenOnly ? "No broken claims." : "No claims match."}
          />
        )}

        {activeTab === "warm-pools" && (
          <DataTable
            columns={warmPoolColumns}
            data={warmPools}
            onSelect={openWarmPool}
            rowHighlight={(warmPool) => warmPool.readyReplicas < warmPool.desiredReplicas}
            emptyMessage={brokenOnly ? "No underfilled warm pools." : "No warm pools match."}
          />
        )}

        {activeTab === "templates" && (
          <DataTable
            columns={templateColumns}
            data={templates}
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
