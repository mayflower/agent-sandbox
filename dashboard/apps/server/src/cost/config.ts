import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
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

/** Minimal yaml subset parser — flat scalars + nested arrays/maps with two-
 *  space indentation. Sufficient for cost.yaml's shape and avoids adding a
 *  yaml dependency. Rejects anything more complex. */
function parseFlatYaml(text: string): RawCostFile {
  const lines = text.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  type Frame = { obj: Record<string, unknown> | unknown[]; indent: number };
  const stack: Frame[] = [{ obj: root, indent: -1 }];

  function parseScalar(value: string): unknown {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "null") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed.replace(/^"|"$/g, "");
  }

  function indentOf(line: string): number {
    return line.match(/^ */)?.[0].length ?? 0;
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = indentOf(line);
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop();
    const parent = stack.at(-1)!.obj;
    const content = line.slice(indent);

    if (content.startsWith("- ")) {
      if (!Array.isArray(parent)) throw new Error(`unexpected list at line: ${rawLine}`);
      const after = content.slice(2);
      if (after.includes(":")) {
        const child: Record<string, unknown> = {};
        parent.push(child);
        const [key, ...rest] = after.split(":");
        const value = rest.join(":").trim();
        if (value === "") {
          stack.push({ obj: child, indent });
        } else {
          child[key!.trim()] = parseScalar(value);
        }
      } else {
        parent.push(parseScalar(after));
      }
      continue;
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;
    const key = content.slice(0, colonIdx).trim();
    const value = content.slice(colonIdx + 1).trim();
    if (!Array.isArray(parent)) {
      if (value === "") {
        // Peek next non-blank line to decide map vs list
        const next = lines.slice(lines.indexOf(rawLine) + 1).find((peek) => peek.trim());
        const child: Record<string, unknown> | unknown[] = next && next.trimStart().startsWith("- ") ? [] : {};
        parent[key] = child;
        stack.push({ obj: child, indent });
      } else {
        parent[key] = parseScalar(value);
      }
    }
  }

  return root as RawCostFile;
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

export interface CostConfigLoader {
  current(): CostRates | null;
  start(): void;
  stop(): void;
  configPath(): string;
  onChange(handler: (rates: CostRates | null) => void): () => void;
}

export function createCostConfigLoader(configPath: string): CostConfigLoader {
  const absolute = path.resolve(configPath);
  let current: CostRates | null = null;
  let watcher: FSWatcher | null = null;
  const listeners = new Set<(rates: CostRates | null) => void>();

  function load(): void {
    if (!existsSync(absolute)) {
      current = null;
      return;
    }
    try {
      const text = readFileSync(absolute, "utf8");
      current = toRates(parseFlatYaml(text));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[cost] failed to load ${absolute}: ${(error as Error).message}`);
      current = null;
    }
  }

  return {
    current: () => current,
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
      } catch {
        // Directory may not exist yet — config is optional.
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
