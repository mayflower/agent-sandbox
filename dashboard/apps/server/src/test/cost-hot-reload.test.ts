import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCostConfigLoader } from "../cost/config.js";

function waitForChange(loader: ReturnType<typeof createCostConfigLoader>, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = loader.onChange(() => {
      stop();
      resolve();
    });
    setTimeout(() => {
      stop();
      reject(new Error("timeout waiting for cost config change"));
    }, timeoutMs);
  });
}

describe("CostConfigLoader hot reload + parsing", () => {
  it("retains previous rates when the file becomes unparseable", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cost-hot-"));
    const file = path.join(dir, "cost.yaml");
    writeFileSync(file, "cpu_per_core_hour_usd: 0.10\n");
    const loader = createCostConfigLoader(file);
    loader.start();
    try {
      expect(loader.current()?.cpuPerCoreHourUsd).toBeCloseTo(0.10);
      const wait = waitForChange(loader);
      writeFileSync(file, "this: is: not: valid: yaml: :::");
      await wait;
      // After parse failure, status flips but `current` is preserved.
      expect(loader.status().code).toBe("parse-error");
      expect(loader.current()?.cpuPerCoreHourUsd).toBeCloseTo(0.10);
    } finally {
      loader.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses node_pool_overrides with nested map under list item", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cost-pool-"));
    const file = path.join(dir, "cost.yaml");
    writeFileSync(
      file,
      "cpu_per_core_hour_usd: 0.05\n" +
        "memory_per_gib_hour_usd: 0.006\n" +
        "node_pool_overrides:\n" +
        "  - selector:\n" +
        "      node.kubernetes.io/instance-type: n2-standard-8\n" +
        "    cpu_per_core_hour_usd: 0.038\n",
    );
    try {
      const loader = createCostConfigLoader(file);
      loader.start();
      const rates = loader.current();
      expect(rates).not.toBeNull();
      expect(rates?.cpuPerCoreHourUsd).toBeCloseTo(0.05);
      expect(rates?.nodePoolOverrides).toHaveLength(1);
      expect(rates?.nodePoolOverrides[0]?.cpuPerCoreHourUsd).toBeCloseTo(0.038);
      expect(rates?.nodePoolOverrides[0]?.selector?.["node.kubernetes.io/instance-type"]).toBe("n2-standard-8");
      loader.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
