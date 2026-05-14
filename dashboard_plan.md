# Plan: Dashboard für Operator-Workflows

## Context

`dashboard/` ist heute ein Resource-Lister mit zwei Charts (Status-Mix
Pie, Template-Footprint Bar) und einem Problems-Panel. Datenmodell und
Provider-Schicht sind solide (`packages/shared/{types,normalizers,overview}.ts`,
`apps/server/src/providers/kubernetes-provider.ts`). Was fehlt, ist alles
was diesem Dashboard *eigene* Daseinsberechtigung gibt gegenüber
`kubectl get` oder lens.dev: Zeit-Dimension, Kausalität, Erzählung,
Kosten, Self-Service.

Das Dashboard ist noch nicht in Produktion. Dieser Plan beschreibt
acht inkrementelle Milestones (M1–M8), die zusammen einen
operationsfähigen, eigenständig wertvollen Dashboard erzeugen — ohne
Abhängigkeit zu externen Observability-Stacks (Grafana, Prometheus,
Loki, Cloud-Billing). Alle Daten stammen aus der Kubernetes-API,
`metrics.k8s.io` (standard K8s), Kubernetes Events und der
agent-sandbox CRD-Status-Subresource.

## Goals

1. **Operator-Antworten in <10 s** auf die sechs häufigsten Fragen
   („brennt was", „warum pending", „was hat sich geändert", „reicht
   die Kapazität", „was kostet das", „wird die Latenz schlechter").
2. **Zeitliche Tiefe**: jeder Status hat Geschichte, jeder Wert hat
   Sparkline, jede Veränderung ist diffbar.
3. **Kausalität**: Probleme werden gruppiert nach Wurzelursache,
   nicht nach Symptom.
4. **Sandbox-Geschichte**: ein Klick auf eine Sandbox ergibt eine
   Erzählung, nicht eine YAML-Liste.
5. **Tenant-Lens**: RBAC-scoped Self-Service für Endnutzer (extend
   lifetime, pause, delete-mine) zusätzlich zur Operator-Lens.
6. **Kostenansicht**: konfigurierbare Node-Preise → Cost pro
   Sandbox / Template / Namespace / Label, inkl. Idle-Spend.
7. **Workflow-orientiert**: erstklassige geführte Pfade für
   „Investigate", „Capacity Audit", „Rollout Preview", „Find What
   Changed".
8. **Pedagogisch**: jede Problemklasse erklärt sich selbst — neue
   Oncall-Rotationen brauchen kein Wiki.

## Non-Goals

- **Kein eingebauter CRD-Editor**. Mutation bleibt auf die heutigen
  guarded Actions (delete claim, reconcile sandbox) beschränkt.
  Strukturänderungen gehen via `kubectl apply`.
- **Keine eingebettete Shell oder Notebook-Umgebung**.
- **Keine Multi-Cluster-Ansicht** in dieser Plan-Iteration.
- **Keine eigene Auth/SSO-Schicht**. Operator-Setup setzt einen
  vorgeschalteten Reverse-Proxy voraus; Dashboard liest Tenant-Identität
  aus einem Header (`X-Forwarded-User` o. ä., konfigurierbar).
- **Keine externe Observability-Integration**. Keine Links zu
  Grafana/Loki/Jaeger. Was im Dashboard sichtbar sein soll, kommt
  vom K8s-API.
- **Keine historischen Daten älter als 7 Tage**. In-Memory + optional
  Disk-Persistenz für 7 Tage. Längere Historie ist Aufgabe eines
  dedizierten Time-Series-Stores, nicht des Dashboard-Servers.

## Reuse vs New

**Reuse:**
- `packages/shared/types.ts` — `RawSandbox`, `RawSandboxClaim`,
  `RawSandboxTemplate`, `RawSandboxWarmPool`, `OverviewSnapshot`,
  `Snapshot`. Erweitern statt ersetzen.
- `packages/shared/normalizers.ts` — `classifyProblems`,
  `normalizeWarmPools`, helper getters.
- `packages/shared/overview.ts` — bleibt der zentrale
  Snapshot→OverviewSnapshot Compiler.
- `apps/server/src/providers/kubernetes-provider.ts` — der Polling-Loop.
  Wird Producer für den Ring-Buffer (M1).
- React Query auf der Web-Seite (`apps/web/src/App.tsx`) — bleibt das
  Polling-Vehikel.
- shadcn/ui Primitives (`apps/web/src/components/ui/*`) — Card, Badge,
  Drawer, Tabs, Progress weiter benutzen.

**Refactor:**
- `InventorySection.tsx` (groß) wird in `InventoryTable`,
  `InventoryFilters`, `SandboxDrawer`, `ClaimDrawer`, `TemplateDrawer`,
  `WarmPoolDrawer` aufgeteilt (M3 startet das, weitere Milestones
  ergänzen Drawer-Inhalte).
- `ProblemsPanel.tsx` bekommt Cause-Effect-Tree (M2).
- `OverviewSection.tsx` wird zur Status-Bar + KPI-Grid (M1, M6).

**New (server-side):**
- `apps/server/src/history/` — Ring-Buffer mit zwei Auflösungen.
- `apps/server/src/cost/` — Cost-Engine.
- `apps/server/src/causality/` — Wurzelursachen-Resolver.
- `apps/server/src/timeline/` — Sandbox-Story-Aggregator.
- `apps/server/src/identity/` — Tenant-Identitäts-Extraktion.

**New (web):**
- `apps/web/src/views/OperatorView.tsx`, `TenantView.tsx`,
  `SandboxStoryView.tsx`.
- `apps/web/src/components/{StatusBar, KpiStrip, Sparkline,
  TimeScrubber, DiffViewer, CauseTree, StoryTimeline, CostPivot,
  SavedViewsTabs, ProblemEducation}.tsx`.

## Architectural Foundations

### Foundation A: Server-side Ring-Buffer

Voraussetzung für Sparklines, Diff, Trend-KPIs, Cost-History.

- Resolution: 15 s für die letzten 60 min (= 240 Snapshots), 5 min für
  die letzten 7 Tage (= 2016 Snapshots).
- Jeder Snapshot ist eine schmale Projektion (`SnapshotMetricsRow`) mit
  ~30 Skalaren pro Auflösungspunkt — kein voller `Snapshot`.
  - Counts (active sandboxes, pending claims, broken pools, …)
  - Aggregat-Metriken (p50/p95 claim age, warm-pool fill ratios, …)
  - Cost-Roll-Up (total $/h, pro Top-N templates)
- Voller `Snapshot` wird nur für die *letzten 60 min @ 15 s*
  vorgehalten, um „Time-Scrubber"-Diffs zu ermöglichen.
- Optional Disk-Persistenz: `${DASHBOARD_DATA_DIR}/history.ndjson`
  (rotierend pro Tag). Default: nur In-Memory; Config-Flag aktiviert
  Persistenz.
- API: `GET /api/history/metrics?since=...&until=...&res=15s|5m` und
  `GET /api/history/snapshot?at=<iso8601>`.

### Foundation B: Cost-Engine

- Konfiguration via `dashboard/config/cost.yaml` (vom Operator
  bereitgestellt, eingelesen beim Server-Start, hot-reload via
  `inotify`):
  ```yaml
  cpu_per_core_hour_usd: 0.045
  memory_per_gib_hour_usd: 0.006
  storage_per_gib_month_usd: 0.10
  # Optional: per-nodepool overrides
  node_pool_overrides:
    - selector: { node.kubernetes.io/instance-type: "n2-standard-8" }
      cpu_per_core_hour_usd: 0.038
      memory_per_gib_hour_usd: 0.005
  ```
- Berechnung pro Pod: `requests.cpu × cpu_rate × uptime + requests.memory × mem_rate × uptime`.
- Storage: aus `volumeClaimTemplates[].spec.resources.requests.storage × storage_rate × duration`.
- Wenn `cost.yaml` fehlt: Cost-View ist ausgeblendet, kein Fehler. Cost ist optional.

### Foundation C: Tenant-Identität

- Default-Operator-Modus: alle Namespaces sichtbar.
- Tenant-Modus aktiviert per Config:
  ```yaml
  tenancy:
    enabled: true
    user_header: "X-Forwarded-User"
    tenant_namespace_label: "agent-sandbox.x-k8s.io/tenant"
    operator_groups: ["sandbox-operators"]
    operator_group_header: "X-Forwarded-Groups"
  ```
- Server liest Header pro Request, filtert Snapshot-Daten auf Namespaces
  die zum Tenant passen (`status.labels[tenant_namespace_label]` matched
  oder direkter Owner über `metadata.annotations[...] = user_id`).
- Web bekommt `GET /api/identity` → `{ user, role: "operator" | "tenant", tenants: [...] }`.

### Foundation D: Causality Resolver

- Beim Snapshot-Building: jedes Problem wird mit einer `caused_by_id`
  versehen, wo ableitbar.
- Regeln (deklarativ, in `packages/shared/causality.ts`):
  - `pod.imagePullBackOff` ist Wurzel.
  - `sandbox.runtime-missing` mit Pod-Phase=Pending+`Reason=ContainerCreating`
    → caused_by Pod-Reason.
  - `warmpool.fill-deficit` (readyReplicas < replicas) → caused_by die
    schlechtesten Members.
  - `claim.pending` → caused_by warmpool-deficit oder template-missing.
  - `template.unmapped-sandboxes` → caused_by Operator-Drift (nicht
    automatisierbar, bleibt Symptom).
- Topologische Sortierung erzeugt einen DAG; UI rendert als
  zusammenklappbarer Tree.

### Foundation E: Event-Indexed Timeline Store

Pro Sandbox: Liste von typisierten Events, time-sortiert.

- Quellen:
  - K8s Events (kind=Pod, kind=Sandbox, kind=SandboxClaim,
    kind=SandboxWarmPool, filter auf den Sandbox-Identitätsraum)
  - Snapshot-Diffs (transitions wie `Ready=False → Ready=True`)
  - Sandbox-Router Request-Log falls verfügbar (optional;
    enabled via config flag)
- Server hält pro Sandbox max 500 Events oder 24h, je nachdem was
  zuerst zutrifft.
- API: `GET /api/timeline/sandbox/:namespace/:name`.

---

## Information Architecture

### Three Top-Level Views

1. **Operator View** (`/operator`, default for `role=operator`):
   Cross-cluster, alle Namespaces, Problems-first, KPIs oben.
2. **Tenant View** (`/me`, default for `role=tenant`):
   Eigene Claims/Sandboxes, eigene Quota, eigene Kosten, eigene
   Pending-Status mit Self-Service Actions.
3. **Sandbox Story View** (`/sandbox/:ns/:name`): einzelne Sandbox als
   Erzählung — Timeline statt Card-Felder.

URL-Routing via React Router (neu hinzufügen — heute hat das Web ein
einseitiges Layout).

### Status Bar (top of every view, sticky)

```
[name]   cluster OK | 1🔥 12⚠ p95-cold 8.2s↑ | updated 3s ago | [search]
         [namespace ▾] [broken ◯] [my team ◯] [refresh]
```

- Linke Cluster-Status-Section ist Operator-only.
- Rechte Filters propagieren in einen `useFilterStore` (zustand-basiert,
  URL-synced).
- Crisis-Mode-Hintergrund (subtiler roter Rand) aktiviert sich bei
  N≥3 critical problems — peripheral-vision Signal.

### KPI-Strip (Operator View, unter Status Bar)

Statt heutigem Pie + Bar-Chart:

| KPI | Zahl | Sparkline (last 60min) | Drill-down |
|---|---|---|---|
| Active Sandboxes | 123 | ▁▂▆█▃ | →Inventory |
| Pending Claims | 17 | ▆▆▇▇▇ | →Problems "claim-pending" |
| Warm Pool Fill | 91% | ▇▇▇▇▆ | →WarmPoolMatrix |
| Cold-Start p95 | 8.2s↑ | ▂▃▄▅▆ | →Timeline (Story view) |
| Failed Pods | 3 | ▁▁▂▁▃ | →Problems "pod-failed" |
| Cost / hour | $12.40 | ▆▆▇█▇ | →Cost view (M4) |

Sparklines lesen `GET /api/history/metrics`. KPI-Cards sind klickbar.

---

## Milestones

### M1 — Foundations: Ring-Buffer, History API, Sparklines, URL state

**Goal:** Time-Dimension einbauen. Jede Zahl bekommt Sparkline,
„updated Xs ago" sichtbar, URL-state, gespeicherte Filter-Tabs.

**Server (`apps/server/src/history/`):**
- `history-store.ts`: zwei Ring-Buffer (15s/60min, 5min/7d). Push-on-snapshot.
- `metrics-projection.ts`: pure Funktion `Snapshot → SnapshotMetricsRow`.
- `routes.ts` (registered in `app.ts`): `/api/history/metrics`,
  `/api/history/snapshot?at=...`.

**Shared:**
- `packages/shared/types.ts`: `SnapshotMetricsRow`, `HistorySeries`.
- `packages/shared/metrics.ts`: same projection used both server- and
  test-side.

**Web:**
- `apps/web/src/lib/url-state.ts`: serialize/deserialize filter state
  to query string (`?ns=...&q=...&broken=1&view=operator`).
- `apps/web/src/lib/filters.ts`: zustand store synced with URL.
- `apps/web/src/components/Sparkline.tsx`: tiny pure-css/svg sparkline
  (max 60 points, 80×20 px).
- `apps/web/src/components/KpiStrip.tsx`: replace Overview's
  pie+bar with KPI cards.
- `apps/web/src/components/StatusBar.tsx`: sticky top bar with
  global filters + updated-at + manual refresh + crisis-mode background.
- `apps/web/src/components/SavedViewsTabs.tsx`: tab bar with
  predefined views (`All`, `My Team`, `Broken Only`, `Pending`,
  `Recently Changed`) plus user-defined saved filter combinations
  stored in `localStorage`.

**Test:**
- Server: history-store ringbuffer rollover, projection invariants.
- Web: URL round-trip, sparkline rendering.

**Acceptance:** `/operator?ns=team-a&broken=1` reload preserves
filter; KPI cards show sparkline; updated-at counter visible.

---

### M2 — Cause-Effect Graph + Problems v2

**Goal:** Probleme werden kausal gruppiert. Operator sieht eine Wurzel
mit ihren Effekten, nicht eine flache Liste.

**Shared:**
- `packages/shared/causality.ts`: rule-based resolver producing
  `ProblemNode { id, severity, summary, parent_id?, affected_resources[] }`.
- `packages/shared/types.ts`: add `ProblemDag` with `roots[]` and
  `byId{}`.

**Server:**
- `apps/server/src/causality/build-dag.ts`: called per-snapshot, attached
  to `Snapshot.problems` as a sibling field `problemDag`.

**Web:**
- `apps/web/src/components/CauseTree.tsx`: collapsible tree, root
  problems open by default.
- `apps/web/src/components/ProblemEducation.tsx`: each problem class
  carries an inline „what does this mean / what to check first" snippet
  read from `packages/shared/problem-docs.ts`.
- `ProblemsPanel.tsx` refactored to render the DAG instead of the flat
  list. Clicking a root expands children; clicking an affected resource
  opens its drawer.

**Test:**
- Causality rules: each rule produces expected parent_id given fixture
  snapshots.
- DAG has no cycles, topological order makes sense.

**Acceptance:** Snapshot with `template.image-pull-error` produces a
DAG where 12 pending claims and 3 warm-pool deficits are children, not
siblings. Inline education paragraph readable for each problem class.

---

### M3 — Sandbox Story View + Detail Drawers

**Goal:** Single sandbox = story timeline. Drawers replaced for all
four resource kinds.

**Server:**
- `apps/server/src/timeline/timeline-store.ts`: ring buffer of events
  per sandbox (max 500/24h).
- `apps/server/src/timeline/event-sources/k8s-events.ts`: K8s Events
  watch, filter on Sandbox/Pod/Claim/WarmPool.
- `apps/server/src/timeline/event-sources/snapshot-diff.ts`: derive
  transition events from sequential snapshots (Ready=False → Ready=True,
  Phase changes, condition reason changes).
- `apps/server/src/timeline/event-sources/router-log.ts`: optional;
  only enabled if `router_log_url` is configured. Out of scope to
  build the router itself.
- `apps/server/src/routes.ts`: `GET /api/timeline/sandbox/:ns/:name`.

**Shared:**
- `packages/shared/timeline.ts`: typed events
  (`PodEvent | SandboxEvent | ClaimEvent | RouterEvent | TransitionEvent`).
- `packages/shared/story.ts`: pure function `events → narrativeRows[]`
  with localizable verb mapping (`PodScheduled → "Pod scheduled"`,
  `Sandbox.Condition[Ready].LastTransitionTime → "Ready"`, etc.).

**Web:**
- `apps/web/src/views/SandboxStoryView.tsx`: top-level route
  `/sandbox/:ns/:name`. Layout: header card (identity, status,
  countdown), timeline (vertical, time-descending), side panel
  (current spec snapshot, owner chain, copyable kubectl hints).
- `apps/web/src/components/StoryTimeline.tsx`: vertical event list
  with icons per event type, hover for details.
- `apps/web/src/components/CountdownBadge.tsx`: real-time „expires in
  2h 14m" updating via `setInterval`.
- `apps/web/src/components/CopyableKubectlHints.tsx`.
- `apps/web/src/components/SandboxDrawer.tsx` refactored: status, pod,
  owner chain, lifecycle countdown, link to Story View, copyable hints.
- `apps/web/src/components/ClaimDrawer.tsx`, `TemplateDrawer.tsx`,
  `WarmPoolDrawer.tsx`: new drawers with field tables from §
  "Resource Detail Drawer Surfaces" below.

**Test:**
- Story compilation: ordered events for a fixture sandbox lifecycle.
- Drawer rendering snapshot tests.

**Acceptance:** Operator clicks a sandbox row → opens story view with
chronological narrative since pod was scheduled. Lifecycle countdown
updates every second.

---

### M4 — Cost View

**Goal:** Cost per Sandbox / Template / Namespace / Label, plus
idle-spend indicator, plus 7-day cost sparkline.

**Server:**
- `apps/server/src/cost/config.ts`: load + hot-reload `cost.yaml`.
- `apps/server/src/cost/engine.ts`: pure functions
  `costForPod(pod, rates, duration) → CostBreakdown` and
  `costForSnapshot(snapshot, rates) → SnapshotCost`.
- Persistence: cost history is just a column on `SnapshotMetricsRow`
  (already in M1 history store).
- Route: `GET /api/cost/snapshot` returns current breakdown.
- Route: `GET /api/cost/by-dimension?group_by=template|namespace|label:<key>`
  returns rolled-up totals for the current snapshot.

**Shared:**
- `packages/shared/cost.ts`: `CostBreakdown`, `SnapshotCost`,
  `CostByDimension`.

**Web:**
- `apps/web/src/views/CostView.tsx`: pivot table with grouping selector.
- `apps/web/src/components/CostPivot.tsx`: groupable rollup
  (template / namespace / label:key) with per-row sparkline.
- `apps/web/src/components/IdleSpendCallout.tsx`: warm-pool members
  unused in last 24h × hourly rate × 24 = wasted spend, shown as a
  banner on Operator View if > $1/day.
- KPI strip gets a `Cost / hour` card (already designed in IA).
- Cost View is hidden in the navigation if `cost.yaml` is absent.

**Test:**
- Engine: known input → known dollar amount.
- Hot reload of cost.yaml.

**Acceptance:** Operator can switch grouping between Template /
Namespace / Label and see rolled-up dollars per hour with a 24h
sparkline. Idle-spend banner appears when warm pool has unused
members.

---

### M5 — Tenant Lens + Self-Service Actions

**Goal:** Endnutzer kann auf `/me` zugreifen und seine eigenen Claims
sehen, deren Lifetime verlängern, pausieren oder löschen.

**Server:**
- `apps/server/src/identity/middleware.ts`: read user/group headers,
  resolve role, derive accessible namespaces.
- `apps/server/src/identity/filter-snapshot.ts`: given a snapshot and
  identity, return a filtered view.
- `apps/server/src/actions/`:
  - `extend-claim.ts`: PATCH claim with new `lifecycle.shutdownTime`.
  - `pause-sandbox.ts`: PATCH sandbox `spec.replicas = 0`.
  - `resume-sandbox.ts`: PATCH sandbox `spec.replicas = 1`.
  - `delete-claim.ts`: existing; ensure RBAC check against caller's
    namespaces.
- Routes: `POST /api/actions/claim/:ns/:name/extend?seconds=<n>`,
  `POST /api/actions/sandbox/:ns/:name/pause`, `.../resume`.

**Shared:**
- `packages/shared/identity.ts`: `Identity { user, role, namespaces }`.

**Web:**
- `apps/web/src/views/TenantView.tsx`: route `/me`. Layout: my claims
  table, my quota (claims/namespace-quota), my idle warnings,
  self-service action buttons.
- `apps/web/src/components/QuotaPanel.tsx`: progress bars for
  per-namespace ResourceQuota if present.
- `apps/web/src/components/ActionConfirm.tsx`: confirmation dialog
  with one-shot undo (5s) for non-destructive actions
  (extend, pause), no undo for delete.
- Header switches between Operator/Tenant view based on role;
  operators can toggle into Tenant View for any namespace.

**Test:**
- Identity middleware: header parsing, group resolution.
- Actions: PATCH body shape, RBAC refusal path.

**Acceptance:** Tenant logs in via reverse proxy, lands on `/me`,
sees only their namespaces, can extend a claim's lifetime by 30m.
Action persists, status reflects within 5s polling cycle.

---

### M6 — Time Scrubber + Diff + Workflows

**Goal:** Operator kann jeden Punkt der letzten 60 min als Snapshot
ansehen, und zwischen zwei Punkten diffen. Geführte Workflows
(„Investigate", „Capacity Audit", „Rollout Preview").

**Server:**
- Already in M1: `GET /api/history/snapshot?at=<iso8601>`.
- New: `GET /api/history/diff?from=<iso>&to=<iso>` returns
  `SnapshotDiff { added[], removed[], transitions[] }`.

**Shared:**
- `packages/shared/diff.ts`: pure function `(Snapshot, Snapshot) → SnapshotDiff`.

**Web:**
- `apps/web/src/components/TimeScrubber.tsx`: horizontal slider in
  status bar's secondary row, shows last 60min, drag scrubs the
  view's underlying snapshot.
- `apps/web/src/components/DiffViewer.tsx`: side-by-side or unified
  diff highlighting added/removed/transitioned resources.
- Diff highlights on snapshot refresh: items added in the last poll
  blink yellow for 2s; removed items fade.
- `apps/web/src/views/InvestigateWizard.tsx`: opens from a pending
  claim → walks Pod → Events → Owner chain → Template → suggested
  fix (heuristic).
- `apps/web/src/views/CapacityWizard.tsx`: shows projected time-to-
  quota per namespace; per warm-pool projected fill.
- `apps/web/src/views/RolloutPreviewWizard.tsx`: given a template
  name, lists all warm-pool members and claims that would be affected
  by an edit, color-coded by `updateStrategy` impact.

**Test:**
- Diff: known fixture snapshots → expected delta.
- Wizards: rendering and navigation.

**Acceptance:** Operator sees a problem appear, scrubs back 10 min
to verify it's new, clicks „Investigate" → gets a guided drill into
the likely cause within 3 clicks.

---

### M7 — Saved Searches, URL Sharing, UX Micro-Wins, Pedagogy

**Goal:** Operator-Komfort: alles teilbar, alles speicherbar,
alles erklärt sich.

**Web:**
- `apps/web/src/lib/saved-views.ts`: `localStorage`-backed; name a
  filter combination, pin as tab, export/import as URL.
- URL-shareable state extended to cover open drawer
  (`?drawer=sandbox:default/foo-bar`), expanded problem groups,
  scrubber position.
- `apps/web/src/components/DensityToggle.tsx`: compact / comfortable
  / card view persisted per-user.
- `apps/web/src/components/EmptyState.tsx`: contextual empty states
  with actionable next steps (no "No data" walls).
- `packages/shared/problem-docs.ts`: 1-paragraph explanation + first
  check per problem class. M2 reads these.
- `apps/web/src/components/AckButton.tsx`: acknowledge a problem with
  optional reason + reminder; ack'd problems hide from default view,
  remain visible under „Acknowledged".
- Crisis-mode background tied to count of unack'd critical problems.

**Test:**
- Saved-view round-trip (localStorage + URL).
- Ack persistence across reloads.

**Acceptance:** Operator copies a URL from one machine, opens it on
another, sees identical filters + drawer + scrubber state. Ack'd
problem stays ack'd after reload until expiry.

---

### M8 — Behavioral Observability (from controller-derivable data only)

**Goal:** Was tun die Sandboxes? Ohne externe Observability-Stacks.

**Server:**
- `apps/server/src/behavior/`:
  - `pod-metrics.ts`: read `metrics.k8s.io/v1beta1/pods` (standard
    K8s, ships with metrics-server). Resolve to per-sandbox
    cpu/mem usage.
  - `network-policy-egress.ts`: count distinct external destinations
    *only if* the cluster exports flow logs as K8s Events or
    annotations. Skip silently otherwise.
  - `event-stats.ts`: aggregate per-template event counts and types
    (e.g., `FailedScheduling` rate per template).
- Routes: `GET /api/behavior/sandbox/:ns/:name` returns per-sandbox
  usage; `GET /api/behavior/template/:name` returns aggregate.

**Shared:**
- `packages/shared/behavior.ts`: `SandboxBehavior`, `TemplateBehavior`.

**Web:**
- `apps/web/src/components/SandboxBehaviorCard.tsx`: cpu/mem usage
  vs requested; anomaly badge if usage > 2× template median.
- `apps/web/src/components/TemplateBehaviorCard.tsx`: median session
  length, p95 cold start, event-rate sparkline. Visible in Template
  drawer.
- Story view's side panel gets a "Activity" tab with cpu/mem time
  series during the sandbox's life.

**Test:**
- Pod-metrics parsing.
- Aggregation correctness.

**Acceptance:** A sandbox using 200x its template's median CPU
appears with an anomaly badge. Template drawer shows session-length
distribution and event-rate trend.

---

## Resource Detail Drawer Surfaces

Operator-facing fields. **L**=listed in inventory column, **D**=in
detail drawer.

### Sandbox

| Field | Where | Notes |
|---|---|---|
| `metadata.{namespace, name, creationTimestamp}` | L | Standard |
| `spec.replicas` (0=paused) | L | Show 🟡 paused badge |
| `spec.service` | D | Boolean, affects service field below |
| `spec.lifecycle.{shutdownTime, shutdownPolicy}` | L | Countdown badge |
| `spec.podTemplate.spec.containers[0].{image, workingDir}` | D | Image is critical |
| `spec.podTemplate.spec.containers[0].resources.{requests, limits}` | D | CPU+Mem |
| `spec.podTemplate.spec.containers[0].env` (count, redacted) | D | Reveal-on-click |
| `spec.podTemplate.spec.securityContext` | D | runAsNonRoot, capabilities |
| `spec.volumeClaimTemplates[].spec.resources.requests.storage` | D | Storage |
| `status.{serviceFQDN, service, podIPs}` | L (FQDN), D (rest) | Copyable |
| `status.conditions[]` | D | Show only non-Ready |
| Owner chain (Claim → Sandbox → Pod → PVCs) | D | Linked |
| Events (last 15min, sandbox + pod) | D | Pre-filtered |
| Behavior (cpu/mem from metrics-server) | D (M8) | Anomaly badge |

### SandboxClaim

| Field | Where | Notes |
|---|---|---|
| `metadata.{namespace, name}` | L | |
| `spec.sandboxTemplateRef.name` | L | Linked |
| `spec.lifecycle.{shutdownTime, ttlSecondsAfterFinished, shutdownPolicy}` | L | Countdown |
| `spec.warmpool` (none/default/named) | D | Explains adoption latency |
| `spec.env` (diff vs template if `envVarsInjectionPolicy=Overrides`) | D | |
| `spec.additionalPodMetadata.labels` (esp. session-id) | D | |
| `status.conditions[Ready].reason` | L | Reason for pending |
| `status.sandbox.{name, podIPs}` | D | Linked to sandbox |

### SandboxTemplate

| Field | Where | Notes |
|---|---|---|
| `metadata.name` | L | |
| `spec.podTemplate.spec.containers[0].image` | L | |
| `spec.podTemplate.spec.containers[0].resources` | D | |
| `spec.podTemplate.spec.securityContext` | D | Compliance |
| `spec.podTemplate.spec.containers[0].workingDir` | D | |
| `spec.volumeClaimTemplates[]` (count + storage) | D | |
| `spec.networkPolicy` (custom rules count) | L | Indicator |
| `spec.networkPolicyManagement` | D | |
| `spec.envVarsInjectionPolicy` | D | |
| Adoption count (claims + pools referencing) | L | Blast radius |
| Template behavior (M8) | D | Session length, cold start, event rate |

### SandboxWarmPool

| Field | Where | Notes |
|---|---|---|
| `spec.replicas` (desired) | L | |
| `status.readyReplicas` | L | `X / Y` style |
| `creating / failed / stale` counts | L | Derived from member pods |
| `spec.sandboxTemplateRef.name` | L | Linked |
| `spec.updateStrategy.type` | D | Stale-pod implications |
| HPA status (if present) | D | |
| Adoption hit/miss ratio (last 1h, last 24h) | D (M8) | |

---

## File Changes Summary

```
dashboard/
├── apps/server/src/
│   ├── app.ts                              ↻ register new route modules
│   ├── history/
│   │   ├── history-store.ts                + ring buffer
│   │   ├── metrics-projection.ts           + Snapshot → metrics row
│   │   └── routes.ts                       + /api/history/*
│   ├── causality/
│   │   └── build-dag.ts                    + attaches problemDag to snapshot
│   ├── cost/
│   │   ├── config.ts                       + load + watch cost.yaml
│   │   ├── engine.ts                       + per-pod / per-snapshot cost
│   │   └── routes.ts                       + /api/cost/*
│   ├── timeline/
│   │   ├── timeline-store.ts               + per-sandbox event ring
│   │   ├── event-sources/
│   │   │   ├── k8s-events.ts               + watch
│   │   │   ├── snapshot-diff.ts            + transitions
│   │   │   └── router-log.ts               + optional
│   │   └── routes.ts                       + /api/timeline/*
│   ├── identity/
│   │   ├── middleware.ts                   + read headers
│   │   └── filter-snapshot.ts              + tenant scoping
│   ├── actions/
│   │   ├── extend-claim.ts                 + PATCH lifecycle
│   │   ├── pause-sandbox.ts                + replicas=0
│   │   ├── resume-sandbox.ts               + replicas=1
│   │   └── delete-claim.ts                 ↻ keep existing
│   └── behavior/
│       ├── pod-metrics.ts                  + metrics-server
│       └── event-stats.ts                  + aggregations
├── packages/shared/src/
│   ├── types.ts                            ↻ add SnapshotMetricsRow,
│   │                                          ProblemDag, SandboxBehavior, …
│   ├── metrics.ts                          + projection
│   ├── causality.ts                        + DAG resolver rules
│   ├── timeline.ts                         + event types
│   ├── story.ts                            + narrative compiler
│   ├── cost.ts                             + types
│   ├── diff.ts                             + pure diff function
│   ├── identity.ts                         + Identity type
│   ├── behavior.ts                         + types
│   └── problem-docs.ts                     + 1-paragraph education per class
├── apps/web/src/
│   ├── App.tsx                             ↻ React Router; mount views
│   ├── views/
│   │   ├── OperatorView.tsx                + default operator landing
│   │   ├── TenantView.tsx                  + /me
│   │   ├── SandboxStoryView.tsx            + /sandbox/:ns/:name
│   │   ├── CostView.tsx                    + /cost
│   │   ├── InvestigateWizard.tsx           + guided
│   │   ├── CapacityWizard.tsx              + projection
│   │   └── RolloutPreviewWizard.tsx        + impact preview
│   ├── components/
│   │   ├── StatusBar.tsx                   + sticky top
│   │   ├── KpiStrip.tsx                    + replaces pie+bar
│   │   ├── Sparkline.tsx                   + pure svg
│   │   ├── SavedViewsTabs.tsx              +
│   │   ├── TimeScrubber.tsx                +
│   │   ├── DiffViewer.tsx                  +
│   │   ├── CauseTree.tsx                   +
│   │   ├── ProblemEducation.tsx            +
│   │   ├── StoryTimeline.tsx               +
│   │   ├── CountdownBadge.tsx              +
│   │   ├── CostPivot.tsx                   +
│   │   ├── IdleSpendCallout.tsx            +
│   │   ├── QuotaPanel.tsx                  +
│   │   ├── ActionConfirm.tsx               +
│   │   ├── DensityToggle.tsx               +
│   │   ├── EmptyState.tsx                  +
│   │   ├── AckButton.tsx                   +
│   │   ├── CopyableKubectlHints.tsx        +
│   │   ├── SandboxBehaviorCard.tsx         +
│   │   ├── TemplateBehaviorCard.tsx        +
│   │   ├── SandboxDrawer.tsx               ↻ extracted from InventorySection
│   │   ├── ClaimDrawer.tsx                 +
│   │   ├── TemplateDrawer.tsx              +
│   │   ├── WarmPoolDrawer.tsx              +
│   │   ├── InventoryFilters.tsx            ↻ split from InventorySection
│   │   ├── InventoryTable.tsx              ↻ split from InventorySection
│   │   ├── OverviewSection.tsx             ↻ deprecated; KPI strip replaces
│   │   └── ProblemsPanel.tsx               ↻ renders CauseTree
│   └── lib/
│       ├── url-state.ts                    + serialize filters
│       ├── filters.ts                      + zustand store
│       ├── saved-views.ts                  + localStorage
│       └── api.ts                          ↻ add history/cost/timeline/etc
├── config/
│   └── cost.yaml.example                   + sample rates
└── dashboard_plan.md                       (this file)
```

`+` = new file, `↻` = modified, `–` = removed.

---

## Verification Per Milestone

Each milestone is independently shippable. Verification structure:

1. Unit tests (server-side store/projection, shared-side pure compilers).
2. Integration test (web → server fixture flow).
3. Visual check on `kind` cluster with fake-provider:
   - Force pending claims via fixture mutation.
   - Force template image-pull-error via image-name typo.
   - Force warm-pool deficit via replicas bump.
4. Real-cluster smoke (`data.mayflower.zone`):
   - Verify sparklines populate after 60s.
   - Verify cost view loads with `cost.yaml`.
   - Verify tenant view filters on a test namespace.

Roll-forward gate per milestone: green CI + visual smoke. No
milestone is gated on the next one.

---

## Performance Constraints

- Snapshot polling stays at 5s (already-cached on server, cheap).
- Ring buffer in memory: 240 metrics rows × ~30 floats + 240 full
  snapshots @ ~50KB each ≈ 12 MB resident. Acceptable.
- Web payload: each `/api/state` response under 200 KB at 200
  sandboxes (today's scale). At 2000 sandboxes the inventory
  endpoint switches to streaming (`?page=...`) — track threshold
  for M8 implementation.
- Sparkline rendering: SVG path, no library, max 60 points → <1ms
  per card on commodity hardware.

---

## Open Questions

1. **Disk persistence default**: ship M1 with disk-flush enabled or
   disabled by default? Suggest disabled — operators with sensitive
   sandbox metadata might not want history on disk.
2. **Tenant identity source**: header-based is simplest but
   couples to reverse-proxy config. Alternative: K8s
   TokenReview at server-side. M5 ships header-based; TokenReview
   is a follow-up.
3. **Cost rate config format**: per-nodepool overrides via
   nodeSelector match is one option. Alternative: per-namespace
   override. Suggest both.
4. **Optimistic UI for actions** (extend, pause): do we show the
   action's effect immediately and reconcile on next poll, or wait
   for the round-trip? Suggest optimistic with 5s undo window.
5. **Crisis-mode threshold**: 3 critical problems? Should this be
   per-operator-team configurable? Start with a constant, make
   configurable when first operator pushes back.
6. **Behavioral data privacy**: if router-log integration ships,
   what gets logged? Should commands be hashed/sampled at the
   router? Out of scope of this plan; flag during M8 review.

---

## Glossary

- **Snapshot** — one full point-in-time view of the cluster's
  sandbox CRDs + pods + events, produced by the server's polling loop.
- **SnapshotMetricsRow** — 30-skalar projection of a Snapshot for
  history storage and sparklines.
- **ProblemDag** — directed acyclic graph of problems with cause-effect
  edges. Roots are likely root causes.
- **Story** — chronologically ordered narrative of events for one
  sandbox.
- **Causality Resolver** — set of rules that turn a flat list of
  problems into a ProblemDag.
- **Cost Engine** — pure functions that convert resource requests +
  duration + node-pool rates into dollar amounts.
- **Time Scrubber** — UI slider that rewinds the view to a historical
  snapshot.
- **Tenant Lens** — RBAC-scoped view of the dashboard limited to a
  user's accessible namespaces.
- **Crisis Mode** — automatic UI state when unack'd critical
  problems exceed a threshold; subtle red rim signals.
