import type { PodMetric } from "@agent-sandbox/dashboard-shared";

export interface PodMetricsResponseItem {
  metadata: { namespace: string; name: string };
  containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
}

const CPU_RE = /^(\d+(?:\.\d+)?)(n|u|m)?$/;
const MEMORY_RE = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/;

function parseCpuMilli(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(CPU_RE);
  if (!match) return 0;
  const raw = Number(match[1]!);
  switch (match[2]) {
    case "n":
      return raw / 1_000_000;
    case "u":
      return raw / 1_000;
    case "m":
      return raw;
    default:
      return raw * 1000;
  }
}

function parseMemoryMib(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(MEMORY_RE);
  if (!match) return 0;
  const raw = Number(match[1]!);
  const unit = match[2];
  switch (unit) {
    case "Ki":
      return (raw * 1024) / (1024 * 1024);
    case "Mi":
      return raw;
    case "Gi":
      return raw * 1024;
    case "Ti":
      return raw * 1024 * 1024;
    default:
      return raw / (1024 * 1024);
  }
}

export function parsePodMetrics(items: PodMetricsResponseItem[]): PodMetric[] {
  return items.map((item) => {
    let cpuMilli = 0;
    let memoryMib = 0;
    for (const container of item.containers ?? []) {
      cpuMilli += parseCpuMilli(container.usage?.cpu);
      memoryMib += parseMemoryMib(container.usage?.memory);
    }
    return {
      namespace: item.metadata.namespace,
      podName: item.metadata.name,
      cpuMilli,
      memoryMib,
    };
  });
}
