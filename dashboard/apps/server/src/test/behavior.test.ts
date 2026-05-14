import { describe, expect, it } from "vitest";
import { parsePodMetrics } from "../behavior/pod-metrics.js";
import { buildSandboxBehavior, buildTemplateBehavior } from "@agent-sandbox/dashboard-shared";

describe("parsePodMetrics", () => {
  it("parses nanocore + Mi units", () => {
    const metrics = parsePodMetrics([
      {
        metadata: { namespace: "demo", name: "pod-1" },
        containers: [{ usage: { cpu: "150000000n", memory: "128Mi" } }],
      },
    ]);
    expect(metrics[0]!.cpuMilli).toBeCloseTo(150);
    expect(metrics[0]!.memoryMib).toBeCloseTo(128);
  });

  it("sums multiple containers", () => {
    const metrics = parsePodMetrics([
      {
        metadata: { namespace: "demo", name: "pod-2" },
        containers: [
          { usage: { cpu: "100m", memory: "32Mi" } },
          { usage: { cpu: "200m", memory: "64Mi" } },
        ],
      },
    ]);
    expect(metrics[0]!.cpuMilli).toBe(300);
    expect(metrics[0]!.memoryMib).toBe(96);
  });
});

describe("buildSandboxBehavior", () => {
  it("flags an anomaly when usage > 2× template median", () => {
    const behavior = buildSandboxBehavior(
      { namespace: "demo", name: "sb", podName: "pod-1", cpuMilliRequested: 1000 },
      [{ namespace: "demo", podName: "pod-1", cpuMilli: 2500, memoryMib: 1024 }],
      1000,
    );
    expect(behavior.anomaly).toBe(true);
  });

  it("does not flag when usage is within range", () => {
    const behavior = buildSandboxBehavior(
      { namespace: "demo", name: "sb", podName: "pod-1" },
      [{ namespace: "demo", podName: "pod-1", cpuMilli: 1200, memoryMib: 1024 }],
      1000,
    );
    expect(behavior.anomaly).toBe(false);
  });
});

describe("buildTemplateBehavior", () => {
  it("aggregates event count and failure count", () => {
    const now = Date.now();
    const behavior = buildTemplateBehavior(
      "py",
      [
        {
          id: "1",
          kind: "sandbox",
          at: new Date(now - 60_000).toISOString(),
          resourceKind: "Sandbox",
          resourceName: "sb",
          namespace: "demo",
          reason: "Created",
          message: "",
          severity: "info",
        },
        {
          id: "2",
          kind: "sandbox",
          at: new Date(now - 30_000).toISOString(),
          resourceKind: "Sandbox",
          resourceName: "sb",
          namespace: "demo",
          reason: "FailedScheduling",
          message: "",
          severity: "warning",
        },
      ],
      [120, 240, 180],
      [10, 15, 50],
    );
    expect(behavior.eventCountLast24h).toBe(2);
    expect(behavior.failureCountLast24h).toBe(1);
    expect(behavior.medianSessionSeconds).toBe(180);
    expect(behavior.p95ColdStartSeconds).toBe(50);
  });
});
