import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_COST_RATES, type CostRates } from "@agent-sandbox/dashboard-shared";

interface RawCostFile {
  cpu_per_core_hour_usd?: number;
  memory_per_gib_hour_usd?: number;
  storage_per_gib_month_usd?: number;
  node_pool_overrides?: Array<{
    selector?: Record<string, string>;
    cpu_per_core_hour_usd?: number;
    memory_per_gib_hour_usd?: number;
  }>;
}

function toRates(raw: RawCostFile): CostRates {
  return {
    cpuPerCoreHourUsd: raw.cpu_per_core_hour_usd ?? DEFAULT_COST_RATES.cpuPerCoreHourUsd,
    memoryPerGibHourUsd: raw.memory_per_gib_hour_usd ?? DEFAULT_COST_RATES.memoryPerGibHourUsd,
    storagePerGibMonthUsd: raw.storage_per_gib_month_usd ?? DEFAULT_COST_RATES.storagePerGibMonthUsd,
    nodePoolOverrides: (raw.node_pool_overrides ?? []).map((entry) => {
      const out: CostRates["nodePoolOverrides"][number] = {
        selector: entry.selector ?? {},
      };
      if (entry.cpu_per_core_hour_usd !== undefined) {
        out.cpuPerCoreHourUsd = entry.cpu_per_core_hour_usd;
      }
      if (entry.memory_per_gib_hour_usd !== undefined) {
        out.memoryPerGibHourUsd = entry.memory_per_gib_hour_usd;
      }
      return out;
    }),
  };
}

export type CostConfigStatusCode = "ok" | "missing" | "parse-error" | "io-error";

export interface CostConfigStatus {
  code: CostConfigStatusCode;
  /** Path the loader is watching. */
  path: string;
  /** Operator-facing error description when code !== "ok"/"missing". */
  detail?: string;
  /** ISO timestamp of the last status transition. */
  changedAt: string;
}

export interface CostConfigLoader {
  current(): CostRates | null;
  status(): CostConfigStatus;
  start(): void;
  stop(): void;
  configPath(): string;
  onChange(handler: (rates: CostRates | null) => void): () => void;
}

export function createCostConfigLoader(configPath: string): CostConfigLoader {
  const absolute = path.resolve(configPath);
  // `current` holds the most recent successfully-parsed rates. Parse failures
  // do NOT clobber it — operators expect cost to keep working while they
  // fix a typo.
  let current: CostRates | null = null;
  let watcher: FSWatcher | null = null;
  let lastStatus: CostConfigStatus = {
    code: "missing",
    path: absolute,
    changedAt: new Date().toISOString(),
  };
  const listeners = new Set<(rates: CostRates | null) => void>();

  function updateStatus(code: CostConfigStatusCode, detail?: string): void {
    if (lastStatus.code === code && lastStatus.detail === detail) return;
    lastStatus = {
      code,
      path: absolute,
      changedAt: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  function load(): void {
    if (!existsSync(absolute)) {
      current = null;
      updateStatus("missing");
      return;
    }
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch (error) {
      const detail = (error as Error).message;
      // eslint-disable-next-line no-console
      console.warn(`[cost] read ${absolute} failed: ${detail}`);
      updateStatus("io-error", detail);
      return;
    }
    try {
      const parsed = parseYaml(text) as RawCostFile | null | undefined;
      current = toRates(parsed ?? {});
      updateStatus("ok");
    } catch (error) {
      const detail = (error as Error).message;
      // eslint-disable-next-line no-console
      console.warn(`[cost] parse ${absolute} failed; keeping previous rates: ${detail}`);
      updateStatus("parse-error", detail);
    }
  }

  return {
    current: () => current,
    status: () => lastStatus,
    configPath: () => absolute,
    start: () => {
      load();
      try {
        watcher = watch(path.dirname(absolute), { persistent: false }, (_event, filename) => {
          if (filename === path.basename(absolute)) {
            load();
            for (const listener of listeners) listener(current);
          }
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          // eslint-disable-next-line no-console
          console.warn(`[cost] hot reload disabled (${code ?? "unknown"}): ${(error as Error).message}`);
        }
      }
    },
    stop: () => {
      watcher?.close();
      watcher = null;
    },
    onChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}
