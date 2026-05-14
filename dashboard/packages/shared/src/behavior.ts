import type { SandboxBehavior, TemplateBehavior, TimelineEvent } from "./types.js";

/** Anomaly threshold: usage above 2× template median is flagged. */
export const CPU_ANOMALY_MULTIPLIER = 2;

export interface PodMetric {
  namespace: string;
  podName: string;
  cpuMilli: number;
  memoryMib: number;
}

export interface SandboxRequest {
  namespace: string;
  name: string;
  podName?: string;
  cpuMilliRequested?: number;
  memoryMibRequested?: number;
  templateRef?: string;
}

export function buildSandboxBehavior(
  sandbox: SandboxRequest,
  metrics: PodMetric[],
  templateMedianCpuMilli: number,
): SandboxBehavior {
  const metric = metrics.find(
    (entry) => entry.namespace === sandbox.namespace && entry.podName === sandbox.podName,
  );
  const cpuMilliUsed = metric?.cpuMilli;
  const anomaly =
    cpuMilliUsed !== undefined &&
    templateMedianCpuMilli > 0 &&
    cpuMilliUsed > templateMedianCpuMilli * CPU_ANOMALY_MULTIPLIER;

  const result: SandboxBehavior = {
    namespace: sandbox.namespace,
    name: sandbox.name,
    anomaly,
  };
  if (cpuMilliUsed !== undefined) result.cpuMilliUsed = cpuMilliUsed;
  if (sandbox.cpuMilliRequested !== undefined) result.cpuMilliRequested = sandbox.cpuMilliRequested;
  if (metric?.memoryMib !== undefined) result.memoryMibUsed = metric.memoryMib;
  if (sandbox.memoryMibRequested !== undefined) result.memoryMibRequested = sandbox.memoryMibRequested;
  return result;
}

export function buildTemplateBehavior(
  name: string,
  events: TimelineEvent[],
  sessionDurationsSeconds: number[],
  coldStartSeconds: number[],
): TemplateBehavior {
  function median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
    return sorted[mid]!;
  }

  function percentile(values: number[], p: number): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[rank];
  }

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentEvents = events.filter((event) => Date.parse(event.at) >= dayAgo);
  const failureEvents = recentEvents.filter(
    (event) => event.severity === "error" || event.severity === "warning",
  );

  const result: TemplateBehavior = {
    name,
    eventCountLast24h: recentEvents.length,
    failureCountLast24h: failureEvents.length,
  };
  const medianSession = median(sessionDurationsSeconds);
  if (medianSession !== undefined) result.medianSessionSeconds = medianSession;
  const p95Cold = percentile(coldStartSeconds, 95);
  if (p95Cold !== undefined) result.p95ColdStartSeconds = p95Cold;
  return result;
}
