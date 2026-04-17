import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type {
  Capabilities,
  ClaimLiveView,
  EventView,
  SandboxLiveView,
  TemplateLiveView,
  WarmPoolLiveView,
} from "@agent-sandbox/dashboard-shared";
import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "./ui/badge.js";
import { Card, CardTitle } from "./ui/card.js";
import { Drawer } from "./ui/drawer.js";
import { Progress } from "./ui/progress.js";
import { Tabs } from "./ui/tabs.js";
import { formatAge } from "../lib/utils.js";

type Selection =
  | { title: string; resourceKind: string; namespace: string; resourceName: string; body: ReactNode }
  | null;

function DataTable<T>({
  columns,
  data,
  onSelect,
}: {
  columns: ColumnDef<T>[];
  data: T[];
  onSelect: (row: T) => void;
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-y-2">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-3 py-2 text-left text-xs uppercase tracking-[0.2em] text-stone-500">
                  {header.isPlaceholder ? null : String(header.column.columnDef.header)}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="cursor-pointer rounded-2xl bg-white/75 shadow-sm transition hover:bg-white"
              onClick={() => onSelect(row.original)}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-3 text-sm text-stone-800">
                  {String(cell.getValue() ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventList({ events }: { events: EventView[] }) {
  return (
    <section>
      <h3 className="mb-3 font-semibold text-stone-900">Events</h3>
      <div className="space-y-3">
        {events.length === 0 ? (
          <p className="text-sm text-stone-600">No events for this object.</p>
        ) : (
          events.map((event) => (
            <article key={`${event.resourceKind}-${event.resourceName}-${event.eventTime}-${event.reason}`} className="rounded-2xl border border-stone-200 bg-white/70 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={event.type === "Warning" ? "warning" : "info"}>{event.type ?? "Info"}</Badge>
                <span className="font-semibold text-stone-800">{event.reason ?? "Event"}</span>
              </div>
              <p className="mt-2 text-sm text-stone-700">{event.message}</p>
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
  const tabs = [
    { key: "sandboxes", label: "Sandboxes" },
    ...(capabilities.claims ? [{ key: "claims", label: "Claims" }] : []),
    ...(capabilities.warmPools ? [{ key: "warm-pools", label: "Warm Pools" }] : []),
    ...(capabilities.templates ? [{ key: "templates", label: "Templates" }] : []),
  ];
  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? "sandboxes");
  const [namespaceFilter, setNamespaceFilter] = useState("");
  const [templateFilter, setTemplateFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [selected, setSelected] = useState<Selection>(null);

  const filteredSandboxes = sandboxes.filter(
    (sandbox) =>
      (!namespaceFilter || sandbox.namespace.includes(namespaceFilter)) &&
      (!templateFilter || (sandbox.templateRef ?? "").includes(templateFilter)) &&
      (!ownerFilter || sandbox.ownerKind === ownerFilter),
  );
  const filteredClaims = claims.filter(
    (claim) =>
      (!namespaceFilter || claim.namespace.includes(namespaceFilter)) &&
      (!templateFilter || claim.templateRef.includes(templateFilter)),
  );
  const filteredWarmPools = warmPools.filter(
    (warmPool) =>
      (!namespaceFilter || warmPool.namespace.includes(namespaceFilter)) &&
      (!templateFilter || warmPool.templateRef.includes(templateFilter)),
  );
  const filteredTemplates = templates.filter(
    (template) =>
      (!namespaceFilter || template.namespace.includes(namespaceFilter)) &&
      (!templateFilter || template.name.includes(templateFilter)),
  );

  const sandboxColumns = useMemo<ColumnDef<SandboxLiveView>[]>(
    () => [
      { header: "Name", accessorKey: "name" },
      { header: "Namespace", accessorKey: "namespace" },
      { header: "Template", accessorKey: "templateRef" },
      { header: "Owner", accessorKey: "ownerKind" },
      { header: "Object", accessorKey: "objectState" },
      { header: "Runtime", accessorKey: "runtimeState" },
    ],
    [],
  );
  const claimColumns = useMemo<ColumnDef<ClaimLiveView>[]>(
    () => [
      { header: "Name", accessorKey: "name" },
      { header: "Template", accessorKey: "templateRef" },
      { header: "WarmPool", accessorKey: "warmPoolPolicy" },
      { header: "State", accessorKey: "state" },
      {
        header: "Mismatch",
        accessorFn: (claim) => (claim.readinessMismatch ? "Mismatch" : "Aligned"),
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
        header: "Capacity",
        accessorFn: (warmPool) => `${Math.round(warmPool.fillRatio * 100)}%`,
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
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <CardTitle>Inventory</CardTitle>
            <p className="mt-1 text-sm text-stone-600">Live, read-only views of sandboxes and extension resources.</p>
          </div>
          <Tabs active={activeTab} onChange={setActiveTab} tabs={tabs} />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            <div className="mb-1 font-semibold text-stone-700">Namespace</div>
            <input className="w-full rounded-2xl border border-stone-300 px-3 py-2" value={namespaceFilter} onChange={(event) => setNamespaceFilter(event.target.value)} />
          </label>
          <label className="text-sm">
            <div className="mb-1 font-semibold text-stone-700">Template</div>
            <input className="w-full rounded-2xl border border-stone-300 px-3 py-2" value={templateFilter} onChange={(event) => setTemplateFilter(event.target.value)} />
          </label>
          <label className="text-sm">
            <div className="mb-1 font-semibold text-stone-700">Owner Kind</div>
            <select className="w-full rounded-2xl border border-stone-300 px-3 py-2" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
              <option value="">All</option>
              <option value="direct">direct</option>
              <option value="claim">claim</option>
              <option value="warm-pool">warm-pool</option>
            </select>
          </label>
        </div>

        {activeTab === "sandboxes" ? (
          <DataTable
            columns={sandboxColumns}
            data={filteredSandboxes}
            onSelect={(sandbox) =>
              setSelected({
                title: sandbox.name,
                namespace: sandbox.namespace,
                resourceKind: "Sandbox",
                resourceName: sandbox.name,
                body: (
                  <div className="space-y-4">
                    <section>
                      <h3 className="font-semibold text-stone-900">Summary</h3>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge tone={sandbox.effectiveReady ? "success" : "warning"}>{sandbox.effectiveReady ? "ready" : "not ready"}</Badge>
                        <Badge tone="info">{sandbox.objectState}</Badge>
                        <Badge tone="neutral">{sandbox.runtimeState}</Badge>
                      </div>
                    </section>
                    <section>
                      <h3 className="font-semibold text-stone-900">Runtime</h3>
                      <p className="mt-2 text-sm text-stone-700">Pod {sandbox.podName ?? "missing"} on {sandbox.nodeName ?? "n/a"} with {sandbox.podIPs.join(", ") || "no IPs"}.</p>
                    </section>
                    <section>
                      <h3 className="font-semibold text-stone-900">Storage</h3>
                      <p className="mt-2 text-sm text-stone-700">{sandbox.pvcNames.length > 0 ? sandbox.pvcNames.join(", ") : "No PVCs attached."}</p>
                    </section>
                    <section>
                      <h3 className="font-semibold text-stone-900">Raw / metadata</h3>
                      <p className="mt-2 text-sm text-stone-700">Age {formatAge(sandbox.ageSeconds)}. Template {sandbox.templateRef ?? "n/a"}.</p>
                    </section>
                  </div>
                ),
              })
            }
          />
        ) : null}

        {activeTab === "claims" ? (
          <DataTable
            columns={claimColumns}
            data={filteredClaims}
            onSelect={(claim) =>
              setSelected({
                title: claim.name,
                namespace: claim.namespace,
                resourceKind: "SandboxClaim",
                resourceName: claim.name,
                body: (
                  <div className="space-y-4">
                    <section>
                      <h3 className="font-semibold text-stone-900">Claim</h3>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge tone={claim.readinessMismatch ? "warning" : "success"}>{claim.readinessMismatch ? "mismatch" : "aligned"}</Badge>
                        <Badge tone="neutral">{claim.state}</Badge>
                      </div>
                    </section>
                    <section>
                      <h3 className="font-semibold text-stone-900">Sandbox summary</h3>
                      <p className="mt-2 text-sm text-stone-700">Sandbox {claim.sandboxName ?? "pending"} with pod IPs {claim.podIPs.join(", ") || "none"}.</p>
                    </section>
                  </div>
                ),
              })
            }
          />
        ) : null}

        {activeTab === "warm-pools" ? (
          <div className="space-y-4">
            <DataTable
              columns={warmPoolColumns}
              data={filteredWarmPools}
              onSelect={(warmPool) =>
                setSelected({
                  title: warmPool.name,
                  namespace: warmPool.namespace,
                  resourceKind: "SandboxWarmPool",
                  resourceName: warmPool.name,
                  body: (
                    <div className="space-y-4">
                      <section>
                        <h3 className="font-semibold text-stone-900">Capacity</h3>
                        <div className="mt-2">
                          <Progress value={warmPool.fillRatio} />
                        </div>
                      </section>
                      <section>
                        <h3 className="font-semibold text-stone-900">Members</h3>
                        <ul className="mt-2 space-y-2 text-sm text-stone-700">
                          {warmPool.memberSandboxes.map((member) => (
                            <li key={member.name}>{member.name} {member.ready ? "ready" : "not ready"}</li>
                          ))}
                        </ul>
                      </section>
                    </div>
                  ),
                })
              }
            />
            {filteredWarmPools.map((warmPool) => (
              <div key={warmPool.name} className="rounded-2xl border border-stone-200 bg-white/65 p-4">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-stone-900">{warmPool.name}</div>
                  {warmPool.readyReplicas < warmPool.desiredReplicas ? <Badge tone="warning">underfilled</Badge> : <Badge tone="success">healthy</Badge>}
                </div>
                <div className="mt-3">
                  <Progress value={warmPool.fillRatio} />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {activeTab === "templates" ? (
          <div className="space-y-4">
            <DataTable
              columns={templateColumns}
              data={filteredTemplates}
              onSelect={(template) =>
                setSelected({
                  title: template.name,
                  namespace: template.namespace,
                  resourceKind: "SandboxTemplate",
                  resourceName: template.name,
                  body: (
                    <div className="space-y-4">
                      <section>
                        <h3 className="font-semibold text-stone-900">Posture</h3>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge tone="info">{template.networkPolicyMode}</Badge>
                          <Badge tone={template.automountServiceAccountTokenDefaultFalse ? "success" : "warning"}>
                            {template.automountServiceAccountTokenDefaultFalse ? "default false posture" : "automount enabled"}
                          </Badge>
                        </div>
                      </section>
                    </div>
                  ),
                })
              }
            />
            {filteredTemplates.map((template) => (
              <div key={template.name} className="rounded-2xl border border-stone-200 bg-white/65 p-4">
                <div className="flex flex-wrap gap-2">
                  <Badge tone="info">{template.networkPolicyMode}</Badge>
                  <Badge tone={template.automountServiceAccountTokenDefaultFalse ? "success" : "warning"}>
                    {template.automountServiceAccountTokenDefaultFalse ? "default false" : "automount enabled"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <Drawer open={selected !== null} title={selected?.title ?? ""} onClose={() => setSelected(null)}>
        {selected?.body}
        <EventList events={selectedEvents} />
      </Drawer>
    </Card>
  );
}
