import { mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import {
  projectSnapshotToMetricsRow,
  type HistoryResolution,
  type HistorySeries,
  type InventorySnapshot,
  type SnapshotCost,
  type SnapshotMetricsRow,
} from "@agent-sandbox/dashboard-shared";

const FIFTEEN_SECONDS_MS = 15_000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FAST_BUFFER_CAPACITY = (60 * 60_000) / FIFTEEN_SECONDS_MS; // 240
const SLOW_BUFFER_CAPACITY = (7 * 24 * 60 * 60_000) / FIVE_MINUTES_MS; // 2016
const FULL_SNAPSHOT_CAPACITY = FAST_BUFFER_CAPACITY;

interface RingBufferState<T> {
  capacity: number;
  values: T[];
}

function createRing<T>(capacity: number): RingBufferState<T> {
  return { capacity, values: [] };
}

function pushRing<T>(ring: RingBufferState<T>, value: T): void {
  ring.values.push(value);
  if (ring.values.length > ring.capacity) {
    ring.values.splice(0, ring.values.length - ring.capacity);
  }
}

export interface HistoryStoreOptions {
  /** Disk persistence directory. If null/undefined, history is in-memory only. */
  dataDir?: string | null;
  /** Maximum file size before rotation (bytes). Default 16 MiB. */
  maxFileBytes?: number;
}

export interface SnapshotCapture {
  at: Date;
  snapshot: InventorySnapshot;
  cost?: SnapshotCost | null;
}

const PERSISTENCE_FILE = "history.ndjson";

/**
 * Two-resolution ring buffer plus optional disk persistence.
 *
 * - `15s` resolution: last 60 min (240 rows)
 * - `5m` resolution: last 7 days (2016 rows)
 *
 * Full snapshots are also retained at the 15 s resolution to power the
 * time-scrubber diff (M6).
 */
export class HistoryStore {
  private readonly fastMetrics: RingBufferState<SnapshotMetricsRow>;
  private readonly slowMetrics: RingBufferState<SnapshotMetricsRow>;
  private readonly fullSnapshots: RingBufferState<{ at: number; snapshot: InventorySnapshot }>;
  private lastSlowFlushAt = 0;
  private readonly persistFile?: string;

  constructor(private readonly options: HistoryStoreOptions = {}) {
    this.fastMetrics = createRing(FAST_BUFFER_CAPACITY);
    this.slowMetrics = createRing(SLOW_BUFFER_CAPACITY);
    this.fullSnapshots = createRing(FULL_SNAPSHOT_CAPACITY);

    if (options.dataDir) {
      const dir = path.resolve(options.dataDir);
      try {
        mkdirSync(dir, { recursive: true });
        this.persistFile = path.join(dir, PERSISTENCE_FILE);
        this.replayPersistence();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[history] disk persistence disabled: ${(error as Error).message}`);
      }
    }
  }

  /** Replay the persisted ndjson rows on startup. */
  private replayPersistence(): void {
    if (!this.persistFile) return;
    let content: string;
    try {
      content = readFileSync(this.persistFile, "utf8");
    } catch {
      return;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as SnapshotMetricsRow;
        if (typeof row?.timestampMs === "number") {
          pushRing(this.fastMetrics, row);
        }
      } catch {
        // Malformed line — skip silently.
      }
    }
    if (this.fastMetrics.values.length > 0) {
      this.lastSlowFlushAt = this.fastMetrics.values.at(-1)!.timestampMs;
    }
  }

  /** Persist a row to ndjson. Errors are logged once and persistence disabled. */
  private persistRow(row: SnapshotMetricsRow): void {
    if (!this.persistFile) return;
    try {
      const fd = openSync(this.persistFile, "a");
      writeSync(fd, JSON.stringify(row) + "\n");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[history] persistence write failed: ${(error as Error).message}`);
    }
  }

  /**
   * Push a snapshot into the ring buffers. The fast ring always accepts the
   * row; the slow ring accumulates one row every five minutes.
   */
  record(capture: SnapshotCapture): SnapshotMetricsRow {
    const projectionInput: Parameters<typeof projectSnapshotToMetricsRow>[0] = {
      snapshot: capture.snapshot,
      now: capture.at,
    };
    if (capture.cost !== undefined && capture.cost !== null) {
      projectionInput.cost = capture.cost;
    }
    const row = projectSnapshotToMetricsRow(projectionInput);

    pushRing(this.fastMetrics, row);
    pushRing(this.fullSnapshots, { at: row.timestampMs, snapshot: capture.snapshot });

    if (row.timestampMs - this.lastSlowFlushAt >= FIVE_MINUTES_MS) {
      pushRing(this.slowMetrics, row);
      this.lastSlowFlushAt = row.timestampMs;
    }

    this.persistRow(row);
    return row;
  }

  series(resolution: HistoryResolution, since?: number, until?: number): HistorySeries {
    const source = resolution === "15s" ? this.fastMetrics.values : this.slowMetrics.values;
    const filtered = source.filter((row) => {
      if (since !== undefined && row.timestampMs < since) return false;
      if (until !== undefined && row.timestampMs > until) return false;
      return true;
    });
    return { resolution, rows: filtered };
  }

  /** Returns the full snapshot closest in time to `at`, within ±2 minutes. */
  snapshotAt(at: number, toleranceMs = 2 * 60_000): InventorySnapshot | undefined {
    let best: { snapshot: InventorySnapshot; delta: number } | undefined;
    for (const entry of this.fullSnapshots.values) {
      const delta = Math.abs(entry.at - at);
      if (delta > toleranceMs) continue;
      if (!best || delta < best.delta) best = { snapshot: entry.snapshot, delta };
    }
    return best?.snapshot;
  }

  /** Inspect the currently stored row count — used by tests only. */
  internalState() {
    return {
      fastCount: this.fastMetrics.values.length,
      slowCount: this.slowMetrics.values.length,
      fullCount: this.fullSnapshots.values.length,
    };
  }
}

export { FAST_BUFFER_CAPACITY, SLOW_BUFFER_CAPACITY, FIFTEEN_SECONDS_MS, FIVE_MINUTES_MS };
