import {
  viewForKind,
  type ClaimLiveView,
  type EventView,
  type InventoryView,
  type SandboxLiveView,
  type SandboxResourceKind,
  type TemplateLiveView,
  type WarmPoolLiveView,
} from "@agent-sandbox/dashboard-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ActionButton } from "@/components/ActionButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useFilters } from "@/lib/filters";
import { cn, formatAge } from "@/lib/utils";

function keyOf(resource: { namespace: string; name: string }): string {
  return `${resource.namespace}/${resource.name}`;
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
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</h4>
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
      <p className="mt-2 text-xs text-muted-foreground">
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
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</h4>
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
      <p className="mt-2 text-xs text-muted-foreground">
        {templateMissing
          ? `Template "${claim.templateRef}" is not present; safe to delete.`
          : "Template exists; dashboard only deletes claims whose template is missing."}
      </p>
    </section>
  );
}

function EventList({ events }: { events: EventView[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">No events for this object.</p>;
  }
  return (
    <div className="space-y-1">
      {events.map((event) => (
        <article
          key={`${event.resourceKind}-${event.resourceName}-${event.eventTime}-${event.reason}`}
          className="rounded border border-border bg-background px-2 py-1"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={event.type === "Warning" ? "warning" : "info"} dot>
              {event.reason ?? event.type ?? "Event"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{event.message}</p>
        </article>
      ))}
    </div>
  );
}

const PAGE_SIZE = 15;

function DataTable<T extends { namespace: string; name: string }>({
  columns,
  data,
  expandedKey,
  onToggleRow,
  rowHighlight,
  emptyMessage,
  renderDetail,
}: {
  columns: ColumnDef<T>[];
  data: T[];
  expandedKey: string | null;
  onToggleRow: (row: T) => void;
  rowHighlight?: (row: T) => boolean;
  emptyMessage?: string;
  renderDetail: (row: T) => ReactNode;
}) {
  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => keyOf(row),
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
    autoResetExpanded: false,
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  const expandedIndex = useMemo(() => {
    if (!expandedKey) return -1;
    return data.findIndex((row) => keyOf(row) === expandedKey);
  }, [data, expandedKey]);

  useEffect(() => {
    if (expandedIndex < 0) return;
    const targetPage = Math.floor(expandedIndex / PAGE_SIZE);
    if (targetPage !== table.getState().pagination.pageIndex) {
      table.setPageIndex(targetPage);
    }
  }, [expandedIndex, table]);

  const detailRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (expandedIndex < 0) return;
    detailRowRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [expandedIndex, expandedKey]);

  if (data.length === 0) {
    return <p className="px-2 py-3 text-xs text-muted-foreground">{emptyMessage ?? "No matching resources."}</p>;
  }

  const totalRows = data.length;
  const pageIndex = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();
  const rangeStart = pageIndex * PAGE_SIZE + 1;
  const rangeEnd = Math.min(rangeStart + PAGE_SIZE - 1, totalRows);
  const columnCount = columns.length;

  return (
    <div className="flex flex-col">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="h-8 text-[10px] font-semibold uppercase tracking-wider">
                  {header.isPlaceholder ? null : String(header.column.columnDef.header)}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => {
            const highlighted = rowHighlight?.(row.original) ?? false;
            const rowKey = keyOf(row.original);
            const isExpanded = rowKey === expandedKey;
            return (
              <Fragment key={row.id}>
                <TableRow
                  data-state={isExpanded ? "selected" : undefined}
                  className={cn(
                    "cursor-pointer text-xs",
                    highlighted && "bg-rose-500/5 hover:bg-rose-500/10",
                    isExpanded && "bg-accent/60",
                  )}
                  onClick={() => onToggleRow(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-1.5">
                      {cell.column.columnDef.cell
                        ? flexRender(cell.column.columnDef.cell, cell.getContext())
                        : String(cell.getValue() ?? "")}
                    </TableCell>
                  ))}
                </TableRow>
                {isExpanded && (
                  <TableRow
                    ref={detailRowRef}
                    className="border-b border-border bg-muted/30 hover:bg-muted/30"
                  >
                    <TableCell colSpan={columnCount} className="p-0">
                      <div className="relative px-4 py-4">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="absolute right-2 top-2 h-6 w-6"
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleRow(row.original);
                          }}
                          aria-label="Close detail"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                        {renderDetail(row.original)}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      {pageCount > 1 && (
        <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {rangeStart}–{rangeEnd} of {totalRows}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="h-6 w-6"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <span className="px-1 tabular-nums">
              {pageIndex + 1}/{pageCount}
            </span>
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="h-6 w-6"
              aria-label="Next page"
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SandboxDetail({
  sandbox,
  claim,
  events,
}: {
  sandbox: SandboxLiveView;
  claim: ClaimLiveView | undefined;
  events: EventView[];
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-3">
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</h4>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Badge tone={sandbox.effectiveReady ? "success" : "warning"} dot>
              {sandbox.effectiveReady ? "ready" : "not ready"}
            </Badge>
            <Badge tone="info">{sandbox.objectState}</Badge>
            <Badge tone="neutral">{sandbox.runtimeState}</Badge>
            <Badge tone="neutral">age {formatAge(sandbox.ageSeconds)}</Badge>
          </div>
        </div>
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Runtime</h4>
          <p className="mt-1.5 text-sm">
            Pod {sandbox.podName ?? "missing"}
            {sandbox.podPhase ? ` (${sandbox.podPhase})` : ""} on {sandbox.nodeName ?? "n/a"}
            {" · "}IPs: {sandbox.podIPs.join(", ") || "none"}
          </p>
        </div>
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Owner</h4>
          <p className="mt-1.5 text-sm">
            {sandbox.ownerKind === "direct" && "Standalone (no claim / no warm pool)"}
            {sandbox.ownerKind === "claim" && `SandboxClaim ${sandbox.claimName ?? "?"}`}
            {sandbox.ownerKind === "warm-pool" && `SandboxWarmPool ${sandbox.warmPoolName ?? "?"}`}
          </p>
          {claim && (
            <p className="mt-1 text-xs text-muted-foreground">
              Claim state: <Badge tone={claim.effectiveReady ? "success" : "warning"}>{claim.state}</Badge>
              {claim.readinessMismatch && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">readiness mismatch</span>
              )}
            </p>
          )}
        </div>
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Template &amp; storage
          </h4>
          <p className="mt-1.5 text-sm">Template {sandbox.templateRef ?? "n/a"}.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            PVCs: {sandbox.pvcNames.length > 0 ? sandbox.pvcNames.join(", ") : "none attached"}
          </p>
        </div>
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">kubectl</h4>
          <pre className="mt-1.5 overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
            kubectl describe sandbox {sandbox.name} -n {sandbox.namespace}
          </pre>
        </div>
        <SandboxActions sandbox={sandbox} />
      </section>
      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Events</h4>
        <div className="mt-1.5">
          <EventList events={events} />
        </div>
      </section>
    </div>
  );
}

function ClaimDetail({
  claim,
  templateMissing,
  events,
}: {
  claim: ClaimLiveView;
  templateMissing: boolean;
  events: EventView[];
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-3">
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Claim</h4>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Badge tone={claim.readinessMismatch ? "warning" : "success"} dot>
              {claim.readinessMismatch ? "mismatch" : "aligned"}
            </Badge>
            <Badge tone="neutral">{claim.state}</Badge>
            <Badge tone="neutral">age {formatAge(claim.ageSeconds)}</Badge>
          </div>
        </div>
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sandbox</h4>
          <p className="mt-1.5 text-sm">
            Sandbox {claim.sandboxName ?? "pending"} · IPs: {claim.podIPs.join(", ") || "none"}
          </p>
        </div>
        {claim.rawReadyCondition && (
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Ready condition
            </h4>
            <p className="mt-1.5 text-sm">
              status={claim.rawReadyCondition.status}
              {claim.rawReadyCondition.reason && ` · reason=${claim.rawReadyCondition.reason}`}
              {claim.rawReadyCondition.message && ` · ${claim.rawReadyCondition.message}`}
            </p>
          </div>
        )}
        <ClaimActions claim={claim} templateMissing={templateMissing} />
      </section>
      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Events</h4>
        <div className="mt-1.5">
          <EventList events={events} />
        </div>
      </section>
    </div>
  );
}

function WarmPoolDetail({ pool, events }: { pool: WarmPoolLiveView; events: EventView[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-3">
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Capacity</h4>
          <div className="mt-1.5">
            <Progress value={Math.min(100, pool.fillRatio * 100)} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {pool.readyReplicas} ready of {pool.desiredReplicas} desired · template {pool.templateRef}
          </p>
        </div>
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Members</h4>
          {pool.memberSandboxes.length === 0 ? (
            <p className="mt-1.5 text-xs text-muted-foreground">No member sandboxes.</p>
          ) : (
            <ul className="mt-1.5 space-y-1 text-sm">
              {pool.memberSandboxes.map((member) => (
                <li key={member.name} className="flex items-center gap-2">
                  <Badge tone={member.ready ? "success" : "warning"} dot>
                    {member.ready ? "ready" : "not ready"}
                  </Badge>
                  <span className="truncate font-mono text-xs">{member.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Events</h4>
        <div className="mt-1.5">
          <EventList events={events} />
        </div>
      </section>
    </div>
  );
}

function TemplateDetail({ template, events }: { template: TemplateLiveView; events: EventView[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-3">
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Posture</h4>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Badge tone="info">{template.networkPolicyMode}</Badge>
            <Badge tone={template.automountServiceAccountTokenDefaultFalse ? "success" : "warning"}>
              {template.automountServiceAccountTokenDefaultFalse
                ? "default false posture"
                : "automount enabled"}
            </Badge>
          </div>
        </div>
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Usage</h4>
          <p className="mt-1.5 text-sm">
            {template.activeSandboxes} sandbox{template.activeSandboxes === 1 ? "" : "es"} ·{" "}
            {template.activeClaims} claim{template.activeClaims === 1 ? "" : "s"} ·{" "}
            {template.activeWarmPools} warm pool{template.activeWarmPools === 1 ? "" : "s"}
          </p>
        </div>
      </section>
      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Events</h4>
        <div className="mt-1.5">
          <EventList events={events} />
        </div>
      </section>
    </div>
  );
}

export function InventorySection({
  view,
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
  view: InventoryView;
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
  const [ownerFilter, setOwnerFilter] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const brokenOnly = filters.brokenOnly;

  const claimOf = useMemo(() => {
    const map = new Map<string, ClaimLiveView>();
    for (const claim of rawClaims) {
      map.set(`${claim.namespace}/${claim.name}`, claim);
    }
    return map;
  }, [rawClaims]);

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

  const sandboxColumns = useMemo<ColumnDef<SandboxLiveView>[]>(() => {
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
  }, [showTemplateColumn]);

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
      { header: "Mismatch", accessorFn: (claim) => (claim.readinessMismatch ? "yes" : "no") },
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
        accessorFn: (template) =>
          template.automountServiceAccountTokenDefaultFalse ? "default false" : "enabled",
      },
      { header: "Claims", accessorKey: "activeClaims" },
      { header: "Sandboxes", accessorKey: "activeSandboxes" },
      { header: "Warm Pools", accessorKey: "activeWarmPools" },
    ],
    [],
  );

  useEffect(() => {
    setExpandedKey(null);
  }, [view]);

  const targetAttemptRef = useRef<{ key: string; attempts: number } | null>(null);
  useEffect(() => {
    const target = filters.target;
    if (!target) {
      targetAttemptRef.current = null;
      return;
    }
    const targetView = viewForKind(target.resourceKind);
    if (targetView !== view) return;
    const lookup = {
      Sandbox: rawSandboxes,
      SandboxClaim: rawClaims,
      SandboxWarmPool: rawWarmPools,
      SandboxTemplate: rawTemplates,
    }[target.resourceKind];
    const inView = lookup?.find(
      (row) => row.namespace === target.namespace && row.name === target.resourceName,
    );
    if (inView) {
      setExpandedKey(keyOf(inView));
      filters.clearTarget();
      targetAttemptRef.current = null;
      return;
    }
    const targetKey = `${target.resourceKind}/${target.namespace}/${target.resourceName}`;
    const current = targetAttemptRef.current;
    const attempts = current && current.key === targetKey ? current.attempts + 1 : 1;
    targetAttemptRef.current = { key: targetKey, attempts };
    if (attempts >= 3) {
      // eslint-disable-next-line no-console
      console.warn(
        `Could not open detail for ${target.resourceKind} ${target.namespace}/${target.resourceName}: not in snapshot after ${attempts} polls`,
      );
      filters.clearTarget();
      targetAttemptRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.target, view, rawSandboxes, rawClaims, rawWarmPools, rawTemplates]);

  const toggleRow = (row: { namespace: string; name: string }) => {
    const key = keyOf(row);
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  const eventsFor = (kind: SandboxResourceKind, namespace: string, name: string) =>
    events.filter(
      (event) =>
        event.resourceKind === kind && event.namespace === namespace && event.resourceName === name,
    );

  return (
    <>
      {view === "sandboxes" && (
        <div className="mb-2 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            owner
            <Select
              value={ownerFilter || "__all"}
              onValueChange={(value) => setOwnerFilter(value === "__all" ? "" : value)}
            >
              <SelectTrigger className="h-7 w-[8rem] text-xs" aria-label="Filter sandboxes by owner kind">
                <SelectValue placeholder="all" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">all</SelectItem>
                <SelectItem value="direct">direct</SelectItem>
                <SelectItem value="claim">claim</SelectItem>
                <SelectItem value="warm-pool">warm-pool</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
      )}

      {view === "sandboxes" && (
        <DataTable
          columns={sandboxColumns}
          data={filteredSandboxes}
          expandedKey={expandedKey}
          onToggleRow={toggleRow}
          rowHighlight={(sandbox) => !sandbox.effectiveReady}
          emptyMessage={brokenOnly ? "No broken sandboxes match." : "No sandboxes match."}
          renderDetail={(sandbox) => (
            <SandboxDetail
              sandbox={sandbox}
              claim={sandbox.claimName ? claimOf.get(`${sandbox.namespace}/${sandbox.claimName}`) : undefined}
              events={eventsFor("Sandbox", sandbox.namespace, sandbox.name)}
            />
          )}
        />
      )}
      {view === "claims" && (
        <DataTable
          columns={claimColumns}
          data={claims}
          expandedKey={expandedKey}
          onToggleRow={toggleRow}
          rowHighlight={(claim) => !claim.effectiveReady || claim.readinessMismatch}
          emptyMessage={brokenOnly ? "No broken claims." : "No claims match."}
          renderDetail={(claim) => (
            <ClaimDetail
              claim={claim}
              templateMissing={!templatePresence.has(`${claim.namespace}/${claim.templateRef}`)}
              events={eventsFor("SandboxClaim", claim.namespace, claim.name)}
            />
          )}
        />
      )}
      {view === "warm-pools" && (
        <DataTable
          columns={warmPoolColumns}
          data={warmPools}
          expandedKey={expandedKey}
          onToggleRow={toggleRow}
          rowHighlight={(pool) => pool.readyReplicas < pool.desiredReplicas}
          emptyMessage={brokenOnly ? "No underfilled warm pools." : "No warm pools match."}
          renderDetail={(pool) => (
            <WarmPoolDetail
              pool={pool}
              events={eventsFor("SandboxWarmPool", pool.namespace, pool.name)}
            />
          )}
        />
      )}
      {view === "templates" && (
        <DataTable
          columns={templateColumns}
          data={templates}
          expandedKey={expandedKey}
          onToggleRow={toggleRow}
          emptyMessage="No templates match."
          renderDetail={(template) => (
            <TemplateDetail
              template={template}
              events={eventsFor("SandboxTemplate", template.namespace, template.name)}
            />
          )}
        />
      )}
    </>
  );
}

