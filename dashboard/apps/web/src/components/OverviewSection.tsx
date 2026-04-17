import type { OverviewSnapshot, PhaseDatum, SandboxPhase } from "@agent-sandbox/dashboard-shared";

import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";

const PHASE_CLASSES: Record<SandboxPhase, string> = {
  ready: "bg-emerald-500",
  starting: "bg-teal-400",
  retained: "bg-slate-400",
  stopped: "bg-stone-400",
  terminating: "bg-amber-400",
  "runtime-missing": "bg-rose-500",
  expired: "bg-stone-500",
  deleting: "bg-amber-600",
};

const PHASE_DOT_CLASSES: Record<SandboxPhase, string> = PHASE_CLASSES;

interface KPIProps {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "neutral" | "warning" | "danger" | "success";
}

function KPI({ label, value, hint, tone = "neutral" }: KPIProps) {
  return (
    <Card className="bg-white/85" title={hint}>
      <div className="text-xs uppercase tracking-[0.24em] text-stone-500">{label}</div>
      <div
        className={cn(
          "mt-2 font-display text-4xl tabular-nums",
          tone === "danger" && "text-rose-700",
          tone === "warning" && "text-amber-700",
          tone === "success" && "text-emerald-700",
          tone === "neutral" && "text-ink",
        )}
      >
        {value}
      </div>
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </Card>
  );
}

function PhaseStrip({ phases, total }: { phases: PhaseDatum[]; total: number }) {
  if (total === 0) {
    return <p className="text-sm text-stone-600">No sandboxes.</p>;
  }
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-stone-200">
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
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-stone-700 md:grid-cols-3">
        {phases.map((entry) => (
          <li key={entry.phase} className="flex items-center gap-2 tabular-nums">
            <span className={cn("h-2.5 w-2.5 rounded-full", PHASE_DOT_CLASSES[entry.phase])} aria-hidden />
            <span className="flex-1 truncate">{entry.label}</span>
            <span className="font-semibold text-ink">{entry.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OverviewSection({ overview }: { overview: OverviewSnapshot }) {
  const { totals, phaseBreakdown } = overview;
  const warmPoolShortfall = totals.warmPoolDesiredTotal - totals.warmPoolReadyTotal;
  const runtimeMissingActive = totals.activeSandboxes - totals.runtimeReadySandboxes;
  const unmappedRatio = totals.totalSandboxes > 0 ? totals.unmappedSandboxes / totals.totalSandboxes : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KPI
          label="Active Sandboxes"
          value={totals.activeSandboxes}
          hint={`${totals.totalSandboxes} total (incl. expired/retained)`}
        />
        <KPI
          label="Runtime Ready"
          value={totals.runtimeReadySandboxes}
          tone={runtimeMissingActive > 0 ? "warning" : "success"}
          hint={runtimeMissingActive > 0 ? `${runtimeMissingActive} active not ready` : "all active sandboxes ready"}
        />
        <KPI
          label="Pending Claims"
          value={totals.pendingClaims}
          tone={totals.pendingClaims > 0 ? "warning" : "neutral"}
          hint={totals.claimsWithReadinessMismatch > 0 ? `${totals.claimsWithReadinessMismatch} with readiness mismatch` : "claim.status.sandbox unbound"}
        />
        <KPI
          label="Warm Pool Ready / Desired"
          value={`${totals.warmPoolReadyTotal} / ${totals.warmPoolDesiredTotal}`}
          tone={warmPoolShortfall > 0 ? "warning" : "success"}
          hint={warmPoolShortfall > 0 ? `${warmPoolShortfall} slot${warmPoolShortfall === 1 ? "" : "s"} short` : "all pools filled"}
        />
      </div>

      <Card data-testid="chart-sandbox-status">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-lg text-ink">Phase breakdown</h2>
          <span className="text-xs text-stone-500 tabular-nums">{totals.totalSandboxes} sandboxes</span>
        </div>
        <div className="mt-3">
          <PhaseStrip phases={phaseBreakdown} total={totals.totalSandboxes} />
        </div>
      </Card>

      {unmappedRatio >= 0.5 && totals.unmappedSandboxes > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{totals.unmappedSandboxes}</strong> of {totals.totalSandboxes} sandboxes have no template label.
          Adopt the <code className="rounded bg-amber-100 px-1">x-k8s.io/sandbox-template</code> annotation to attribute
          workloads to templates.
        </div>
      )}
    </div>
  );
}
