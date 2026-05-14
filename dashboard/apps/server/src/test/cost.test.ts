import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { costForPod, DEFAULT_COST_RATES, type CostRates } from "@agent-sandbox/dashboard-shared";
import { createCostConfigLoader } from "../cost/config.js";

describe("costForPod", () => {
  it("computes CPU + memory + storage cost for a known workload", () => {
    const rates: CostRates = {
      cpuPerCoreHourUsd: 0.10,
      memoryPerGibHourUsd: 0.02,
      storagePerGibMonthUsd: 0.10,
      nodePoolOverrides: [],
    };
    const breakdown = costForPod({ cpuCores: 2, memoryGib: 4, storageGib: 0, uptimeHours: 1 }, rates);
    expect(breakdown.cpuUsd).toBeCloseTo(0.20, 4);
    expect(breakdown.memoryUsd).toBeCloseTo(0.08, 4);
    expect(breakdown.totalUsd).toBeCloseTo(0.28, 4);
  });

  it("applies node-pool overrides when labels match", () => {
    const rates: CostRates = {
      cpuPerCoreHourUsd: 0.10,
      memoryPerGibHourUsd: 0.02,
      storagePerGibMonthUsd: 0.10,
      nodePoolOverrides: [
        { selector: { "node.kubernetes.io/instance-type": "n2-standard-8" }, cpuPerCoreHourUsd: 0.05 },
      ],
    };
    const breakdown = costForPod(
      {
        cpuCores: 2,
        memoryGib: 0,
        storageGib: 0,
        uptimeHours: 1,
        nodeLabels: { "node.kubernetes.io/instance-type": "n2-standard-8" },
      },
      rates,
    );
    expect(breakdown.cpuUsd).toBeCloseTo(0.10, 4);
  });
});

describe("CostConfigLoader", () => {
  it("returns null when file is absent", () => {
    const loader = createCostConfigLoader("/tmp/nonexistent-cost.yaml");
    loader.start();
    expect(loader.current()).toBeNull();
    loader.stop();
  });

  it("loads a minimal yaml file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cost-test-"));
    const file = path.join(dir, "cost.yaml");
    writeFileSync(file, "cpu_per_core_hour_usd: 0.02\nmemory_per_gib_hour_usd: 0.005\nstorage_per_gib_month_usd: 0.5\n");
    try {
      const loader = createCostConfigLoader(file);
      loader.start();
      const rates = loader.current();
      expect(rates).not.toBeNull();
      expect(rates?.cpuPerCoreHourUsd).toBeCloseTo(0.02);
      expect(rates?.memoryPerGibHourUsd).toBeCloseTo(0.005);
      expect(rates?.storagePerGibMonthUsd).toBeCloseTo(0.5);
      loader.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DEFAULT_COST_RATES", () => {
  it("ships with sensible non-zero defaults", () => {
    expect(DEFAULT_COST_RATES.cpuPerCoreHourUsd).toBeGreaterThan(0);
    expect(DEFAULT_COST_RATES.memoryPerGibHourUsd).toBeGreaterThan(0);
    expect(DEFAULT_COST_RATES.storagePerGibMonthUsd).toBeGreaterThan(0);
  });
});
