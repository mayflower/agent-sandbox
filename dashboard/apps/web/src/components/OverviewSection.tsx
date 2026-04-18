import type { LiveOverview, PhaseDatum, SandboxPhase } from "@agent-sandbox/dashboard-shared";
import { AlertTriangle } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PHASE_CLASSES: Record<SandboxPhase, string> = {
  ready: "bg-emerald-500",
  starting: "bg-sky-400",
  retained: "bg-slate-400",
  stopped: "bg-slate-500",
  terminating: "bg-amber-400",
  "runtime-missing": "bg-rose-500",
  expired: "bg-slate-500",
  deleting: "bg-amber-600",
};

interface KPIProps {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "neutral" | "warning" | "danger" | "success";
}

function KPI({ label, value, hint, tone = "neutral" }: KPIProps) {
  return (
    <Card>
      <CardContent className="flex items-baseline justify-between gap-4 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          {hint && (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={hint}>
              {hint}
            </div>
          )}
        </div>
        <div
          className={cn(
            "shrink-0 text-2xl font-semibold leading-none tabular-nums",
            tone === "danger" && "text-rose-600 dark:text-rose-400",
            tone === "warning" && "text-amber-600 dark:text-amber-400",
            tone === "success" && "text-emerald-600 dark:text-emerald-400",
            tone === "neutral" && "text-foreground",
          )}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function PhaseStrip({ phases, total }: { phases: PhaseDatum[]; total: number }) {
  if (total === 0) {
    return <p className="text-xs text-muted-foreground">No sandboxes match filters.</p>;
  }
  return (
    <div>
      <div className="flex h-1.5 w-full overflow-hidden rounded bg-muted">
        {phases.map((entry) => (
          <div
            key={entry.phase}
            className={cn("h-full", PHASE_CLASSES[entry.phase])}
            style={{ width: `${(entry.count / total) * 100}%` }}
            title={`${entry.label}: ${entry.count}`}
            aria-label={`${entry.label}: ${entry.count}`}
          />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {phases.map((entry) => (
          <li key={entry.phase} className="flex items-center gap-1 tabular-nums">
            <span className={cn("h-1.5 w-1.5 rounded-full", PHASE_CLASSES[entry.phase])} aria-hidden />
            <span>{entry.label}</span>
            <span className="font-semibold text-foreground">{entry.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OverviewSection({ overview }: { overview: LiveOverview }) {
  const { totals, phaseBreakdown } = overview;
  const warmPoolShortfall = totals.warmPoolDesiredTotal - totals.warmPoolReadyTotal;
  const runtimeMissingActive = totals.activeSandboxes - totals.runtimeReadySandboxes;
  const unmappedRatio = totals.totalSandboxes > 0 ? totals.unmappedSandboxes / totals.totalSandboxes : 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KPI
          label="Active"
          value={totals.activeSandboxes}
          hint={`${totals.totalSandboxes} total (incl. expired/retained)`}
        />
        <KPI
          label="Runtime ready"
          value={totals.runtimeReadySandboxes}
          tone={runtimeMissingActive > 0 ? "warning" : "success"}
          hint={runtimeMissingActive > 0 ? `${runtimeMissingActive} active not ready` : "all active ready"}
        />
        <KPI
          label="Pending claims"
          value={totals.pendingClaims}
          tone={totals.pendingClaims > 0 ? "warning" : "neutral"}
          hint={
            totals.claimsWithReadinessMismatch > 0
              ? `${totals.claimsWithReadinessMismatch} readiness mismatch`
              : "claim.status.sandbox unbound"
          }
        />
        <KPI
          label="Warm pool"
          value={`${totals.warmPoolReadyTotal}/${totals.warmPoolDesiredTotal}`}
          tone={warmPoolShortfall > 0 ? "warning" : "success"}
          hint={warmPoolShortfall > 0 ? `${warmPoolShortfall} short` : "all pools filled"}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-baseline justify-between gap-3 space-y-0 p-3 pb-1.5">
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Phase breakdown
          </CardTitle>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {totals.totalSandboxes} sandboxes
          </span>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <PhaseStrip phases={phaseBreakdown} total={totals.totalSandboxes} />
        </CardContent>
      </Card>

      {unmappedRatio >= 0.5 && totals.unmappedSandboxes > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <p>
            <strong className="font-semibold">{totals.unmappedSandboxes}</strong> of {totals.totalSandboxes} sandboxes missing{" "}
            <code className="rounded bg-amber-500/20 px-1 font-mono">agents.x-k8s.io/sandbox-template-ref</code>
            {" "}— upgrade the controller and re-annotate affected workloads.
          </p>
        </div>
      )}
    </div>
  );
}
