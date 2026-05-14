import {
  buildSnapshotCost,
  type CostRates,
  type InventoryProvider,
  type InventorySnapshot,
  type PodMetric,
} from "@agent-sandbox/dashboard-shared";
import { HistoryStore } from "./history-store.js";
import { SnapshotDiffEventSource } from "../timeline/event-sources/snapshot-diff.js";
import { eventsForSandbox } from "../timeline/event-sources/k8s-events.js";
import { TimelineStore } from "../timeline/timeline-store.js";

export interface PollLoopDeps {
  provider: InventoryProvider;
  historyStore: HistoryStore;
  timelineStore: TimelineStore;
  getCostRates(): CostRates | null;
  /** Per-pod usage metrics, refreshed externally. May be undefined. */
  getPodMetrics?(): PodMetric[];
  intervalMs?: number;
  /** When false, skip the synchronous initial tick on startup. Tests use this
   *  to drive ticks deterministically. Production callers leave this true. */
  runImmediately?: boolean;
}

const DEFAULT_INTERVAL_MS = 15_000;

export interface PollLoopHandle {
  stop(): void;
  /** Forces an immediate snapshot record without waiting for the interval. */
  tick(): Promise<void>;
  /** Health snapshot for /api/healthz consumers. */
  health(): PollLoopHealth;
}

export interface PollLoopHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
}

export function startPollLoop(deps: PollLoopDeps): PollLoopHandle {
  const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const diffSource = new SnapshotDiffEventSource();
  const health: PollLoopHealth = {
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
  };

  async function tick(): Promise<void> {
    let snapshot: InventorySnapshot;
    try {
      snapshot = await deps.provider.getSnapshot();
    } catch (error) {
      health.lastErrorAt = Date.now();
      health.lastErrorMessage = (error as Error).message;
      health.consecutiveFailures += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[poll] snapshot fetch failed (${health.consecutiveFailures} consecutive): ${health.lastErrorMessage}`,
      );
      return;
    }

    const rates = deps.getCostRates();
    const at = new Date();
    deps.historyStore.record({
      at,
      snapshot,
      cost: rates ? buildSnapshotCost(snapshot, rates, at) : null,
    });

    // Timeline: K8s events per sandbox.
    for (const raw of snapshot.sandboxes) {
      const namespace = raw.metadata.namespace ?? "default";
      const podName =
        raw.metadata.annotations?.["agents.x-k8s.io/pod-name"] ?? raw.metadata.name;
      const ingestArg: Parameters<TimelineStore["ingest"]>[0] = { namespace, name: raw.metadata.name };
      const events = eventsForSandbox(snapshot, { namespace, name: raw.metadata.name, podName });
      if (events.length > 0) deps.timelineStore.ingest(ingestArg, events);
    }

    // Timeline: snapshot-diff transitions.
    const transitions = diffSource.consume(snapshot);
    for (const [key, events] of transitions) {
      const [namespace, ...rest] = key.split("/");
      deps.timelineStore.ingest({ namespace: namespace!, name: rest.join("/") }, events);
    }

    health.lastSuccessAt = Date.now();
    health.consecutiveFailures = 0;
  }

  if (deps.runImmediately !== false) {
    void tick();
  }
  const id = setInterval(() => {
    void tick();
  }, interval);

  return {
    stop: () => clearInterval(id),
    tick,
    health: () => ({ ...health }),
  };
}
