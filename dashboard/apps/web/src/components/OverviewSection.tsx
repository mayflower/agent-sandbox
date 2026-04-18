import type { LiveOverview, PhaseDatum, SandboxPhase } from "@agent-sandbox/dashboard-shared";

import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";

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
    <Card className="py-2" title={hint}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums leading-tight",
          tone === "danger" && "text-rose-700 dark:text-rose-300",
          tone === "warning" && "text-amber-700 dark:text-amber-300",
          tone === "success" && "text-emerald-700 dark:text-emerald-300",
          tone === "neutral" && "text-slate-900 dark:text-slate-100",
        )}
      >
        {value}
      </div>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{hint}</p>}
    </Card>
  );
}

function PhaseStrip({ phases, total }: { phases: PhaseDatum[]; total: number }) {
  if (total === 0) {
    return <p className="text-xs text-slate-500 dark:text-slate-400">No sandboxes match filters.</p>;
  }
  return (
    <div>
      <div className="flex h-1.5 w-full overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
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
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-700 dark:text-slate-300">
        {phases.map((entry) => (
          <li key={entry.phase} className="flex items-center gap-1 tabular-nums">
            <span className={cn("h-1.5 w-1.5 rounded-full", PHASE_CLASSES[entry.phase])} aria-hidden />
            <span>{entry.label}</span>
            <span className="font-semibold text-slate-900 dark:text-slate-100">{entry.count}</span>
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
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
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

      <Card className="py-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Phase breakdown
          </h2>
          <span className="text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
            {totals.totalSandboxes} sandboxes
          </span>
        </div>
        <div className="mt-1.5">
          <PhaseStrip phases={phaseBreakdown} total={totals.totalSandboxes} />
        </div>
      </Card>

      {unmappedRatio >= 0.5 && totals.unmappedSandboxes > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          <strong>{totals.unmappedSandboxes}</strong> of {totals.totalSandboxes} sandboxes missing{" "}
          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-900/60">agents.x-k8s.io/sandbox-template-ref</code>
          {" "}— upgrade the controller and re-annotate affected workloads.
        </div>
      )}
    </div>
  );
}
