import { Card, CardTitle } from "./ui/card.js";
import type { OverviewSnapshot } from "@agent-sandbox/dashboard-shared";
import { BarChart, Bar, CartesianGrid, PieChart, Pie, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const pieColors = ["#0f766e", "#d97706", "#b91c1c", "#0f172a", "#64748b"];

function OverviewCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="bg-white/85">
      <div className="text-xs uppercase tracking-[0.24em] text-stone-500">{label}</div>
      <div className="mt-2 font-display text-4xl text-ink">{value}</div>
    </Card>
  );
}

export function OverviewSection({ overview }: { overview: OverviewSnapshot }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewCard label="Active Sandboxes" value={overview.totals.activeSandboxes} />
        <OverviewCard label="Runtime Ready" value={overview.totals.runtimeReadySandboxes} />
        <OverviewCard label="Pending Claims" value={overview.totals.pendingClaims} />
        <OverviewCard label="Warm Pool Ready / Desired" value={`${overview.totals.warmPoolReadyTotal} / ${overview.totals.warmPoolDesiredTotal}`} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card data-testid="chart-sandbox-status">
          <CardTitle>Status Mix</CardTitle>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={overview.charts.sandboxesByStatus} dataKey="value" nameKey="label" outerRadius={110}>
                  {overview.charts.sandboxesByStatus.map((entry, index) => (
                    <Cell key={entry.label} fill={pieColors[index % pieColors.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card data-testid="chart-template-usage">
          <CardTitle>Template Footprint</CardTitle>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={overview.charts.sandboxesByTemplate}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="value" fill="#0f766e" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}
