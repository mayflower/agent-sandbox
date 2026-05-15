import { normalizeAll } from "./normalizers.js";
import type {
  CostBreakdown,
  CostByDimension,
  CostGroupBy,
  CostRates,
  CostRow,
  InventorySnapshot,
  PodCostInput,
  RawPod,
  RawSandbox,
  RawSandboxTemplate,
  RawSandboxWarmPool,
  SandboxLiveView,
  SnapshotCost,
} from "./types.js";

export const DEFAULT_COST_RATES: CostRates = {
  cpuPerCoreHourUsd: 0.045,
  memoryPerGibHourUsd: 0.006,
  storagePerGibMonthUsd: 0.1,
  nodePoolOverrides: [],
};

const HOURS_PER_MONTH = 24 * 30;

function selectorMatches(
  selector: Record<string, string>,
  labels: Record<string, string> | undefined,
): boolean {
  if (!labels) return false;
  for (const [key, value] of Object.entries(selector)) {
    if (labels[key] !== value) return false;
  }
  return true;
}

export function resolveRatesForLabels(
  rates: CostRates,
  labels: Record<string, string> | undefined,
): { cpu: number; memory: number } {
  for (const override of rates.nodePoolOverrides) {
    if (selectorMatches(override.selector, labels)) {
      return {
        cpu: override.cpuPerCoreHourUsd ?? rates.cpuPerCoreHourUsd,
        memory: override.memoryPerGibHourUsd ?? rates.memoryPerGibHourUsd,
      };
    }
  }
  return { cpu: rates.cpuPerCoreHourUsd, memory: rates.memoryPerGibHourUsd };
}

export function costForPod(input: PodCostInput, rates: CostRates): CostBreakdown {
  const resolved = resolveRatesForLabels(rates, input.nodeLabels);
  const cpuUsd = input.cpuCores * resolved.cpu * input.uptimeHours;
  const memoryUsd = input.memoryGib * resolved.memory * input.uptimeHours;
  // Storage is configured per GiB-month but we charge per uptime hour, so
  // convert: cost = GiB × ($/GiB·month) × (hours / 720).
  const storageHourFraction = input.uptimeHours / HOURS_PER_MONTH;
  const storageUsd = input.storageGib * rates.storagePerGibMonthUsd * storageHourFraction;
  return {
    cpuUsd,
    memoryUsd,
    storageUsd,
    totalUsd: cpuUsd + memoryUsd + storageUsd,
  };
}

const CPU_RE = /^(\d+(?:\.\d+)?)(m)?$/;
const MEMORY_RE = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/;
const STORAGE_RE = MEMORY_RE;

function parseCpu(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(CPU_RE);
  if (!match) return 0;
  const raw = Number(match[1]!);
  return match[2] === "m" ? raw / 1000 : raw;
}

function bytesFromUnit(unit: string | undefined): number {
  switch (unit) {
    case "Ki":
      return 1024;
    case "Mi":
      return 1024 ** 2;
    case "Gi":
      return 1024 ** 3;
    case "Ti":
      return 1024 ** 4;
    case "K":
      return 1000;
    case "M":
      return 1000 ** 2;
    case "G":
      return 1000 ** 3;
    case "T":
      return 1000 ** 4;
    default:
      return 1;
  }
}

function parseMemoryGib(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(MEMORY_RE);
  if (!match) return 0;
  const raw = Number(match[1]!);
  const bytes = raw * bytesFromUnit(match[2]);
  return bytes / 1024 ** 3;
}

function parseStorageGib(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(STORAGE_RE);
  if (!match) return 0;
  const raw = Number(match[1]!);
  // K8s convention: a bare number (no suffix) on a storage request is *bytes*.
  // Memory uses the same regex but elsewhere we treat bare numbers as bytes
  // too — see parseMemoryGib — so behaviour stays consistent.
  const bytes = raw * bytesFromUnit(match[2]);
  return bytes / 1024 ** 3;
}

interface ResourceShape {
  cpuCores: number;
  memoryGib: number;
  storageGib: number;
}

function getSandboxResourceShape(sandbox: RawSandbox): ResourceShape {
  const requests = sandbox.spec.podTemplate.spec.containers[0]?.resources?.requests;
  const storage = (sandbox.spec.volumeClaimTemplates ?? [])
    .map((vct) => parseStorageGib(vct.spec?.resources?.requests?.storage))
    .reduce((sum, gib) => sum + gib, 0);
  return {
    cpuCores: parseCpu(requests?.cpu),
    memoryGib: parseMemoryGib(requests?.memory),
    storageGib: storage,
  };
}

export function getTemplateResourceShape(template: RawSandboxTemplate): ResourceShape {
  const requests = template.spec.podTemplate.spec.containers[0]?.resources?.requests;
  return {
    cpuCores: parseCpu(requests?.cpu),
    memoryGib: parseMemoryGib(requests?.memory),
    storageGib: 0,
  };
}

function findPod(pods: RawPod[], namespace: string, podName: string | undefined): RawPod | undefined {
  if (!podName) return undefined;
  return pods.find(
    (pod) => (pod.metadata.namespace ?? "default") === namespace && pod.metadata.name === podName,
  );
}

function nodeLabelsForPod(pod: RawPod | undefined): Record<string, string> | undefined {
  if (!pod?.spec?.nodeName) return undefined;
  return { "kubernetes.io/hostname": pod.spec.nodeName };
}

export function buildSnapshotCost(snapshot: InventorySnapshot, rates: CostRates, now = new Date()): SnapshotCost {
  const inventory = normalizeAll(snapshot, now);

  let sandboxesUsdPerHour = 0;
  let warmPoolsUsdPerHour = 0;
  let idleUsdPerHour = 0;

  for (const sandbox of inventory.sandboxes) {
    if (sandbox.objectState === "expired" || sandbox.runtimeState === "missing") continue;
    const raw = snapshot.sandboxes.find(
      (entry) => (entry.metadata.namespace ?? "default") === sandbox.namespace && entry.metadata.name === sandbox.name,
    );
    if (!raw) continue;
    const shape = getSandboxResourceShape(raw);
    const pod = findPod(snapshot.pods, sandbox.namespace, sandbox.podName);
    const labels = nodeLabelsForPod(pod);
    const breakdown = costForPod(
      labels === undefined
        ? { ...shape, uptimeHours: 1 }
        : { ...shape, uptimeHours: 1, nodeLabels: labels },
      rates,
    );
    if (sandbox.ownerKind === "warm-pool") {
      warmPoolsUsdPerHour += breakdown.totalUsd;
      if (!sandbox.effectiveReady) idleUsdPerHour += breakdown.totalUsd;
    } else {
      sandboxesUsdPerHour += breakdown.totalUsd;
    }
  }

  return {
    totalUsdPerHour: sandboxesUsdPerHour + warmPoolsUsdPerHour,
    idleUsdPerHour,
    byKind: {
      sandboxesUsdPerHour,
      warmPoolsUsdPerHour,
    },
    rates,
  };
}

export function buildCostByDimension(
  snapshot: InventorySnapshot,
  rates: CostRates,
  groupBy: CostGroupBy,
  now = new Date(),
): CostByDimension {
  const inventory = normalizeAll(snapshot, now);
  const rows = new Map<string, CostRow>();

  function getGroup(sandbox: SandboxLiveView, raw: RawSandbox | undefined): string {
    if (groupBy === "template") return sandbox.templateRef ?? "<unmapped>";
    if (groupBy === "namespace") return sandbox.namespace;
    if (groupBy.startsWith("label:")) {
      const key = groupBy.slice("label:".length);
      return raw?.metadata.labels?.[key] ?? "<unset>";
    }
    return "<unknown>";
  }

  for (const sandbox of inventory.sandboxes) {
    const raw = snapshot.sandboxes.find(
      (entry) =>
        (entry.metadata.namespace ?? "default") === sandbox.namespace && entry.metadata.name === sandbox.name,
    );
    if (!raw) continue;
    if (sandbox.objectState === "expired" || sandbox.runtimeState === "missing") continue;

    const shape = getSandboxResourceShape(raw);
    const pod = findPod(snapshot.pods, sandbox.namespace, sandbox.podName);
    const labels = nodeLabelsForPod(pod);
    const breakdown = costForPod(
      labels === undefined
        ? { ...shape, uptimeHours: 1 }
        : { ...shape, uptimeHours: 1, nodeLabels: labels },
      rates,
    );
    const group = getGroup(sandbox, raw);
    const isIdle = sandbox.ownerKind === "warm-pool" && !sandbox.effectiveReady;
    const existing = rows.get(group);
    if (existing) {
      existing.usdPerHour += breakdown.totalUsd;
      if (isIdle) existing.idleUsdPerHour += breakdown.totalUsd;
      existing.instanceCount += 1;
    } else {
      rows.set(group, {
        group,
        usdPerHour: breakdown.totalUsd,
        idleUsdPerHour: isIdle ? breakdown.totalUsd : 0,
        instanceCount: 1,
      });
    }
  }

  return {
    groupBy,
    rows: [...rows.values()].sort((a, b) => b.usdPerHour - a.usdPerHour),
  };
}

export function projectIdleSpend24h(snapshotCost: SnapshotCost): number {
  return snapshotCost.idleUsdPerHour * 24;
}

export type { RawSandboxWarmPool };
