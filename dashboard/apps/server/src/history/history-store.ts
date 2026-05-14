import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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

/** Two-resolution ring buffer (15 s / 60 min, 5 m / 7 d) plus optional ndjson persistence. */
export class HistoryStore {
  private readonly fastMetrics: RingBufferState<SnapshotMetricsRow>;
  private readonly slowMetrics: RingBufferState<SnapshotMetricsRow>;
  private readonly fullSnapshots: RingBufferState<{ at: number; snapshot: InventorySnapshot }>;
  private lastSlowFlushAt = 0;
  private persistFile: string | undefined;
  private persistFd: number | undefined;
  /** Number of malformed lines seen during replay; logged once via {@link disablePersistence}. */
  private replayMalformedCount = 0;

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
        // Open a long-lived append fd; reused for every record() write below.
        // Caller closes via close().
        this.persistFd = openSync(this.persistFile, "a");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[history] disk persistence disabled: ${(error as Error).message}`);
        this.persistFile = undefined;
      }
    }
  }

  private replayPersistence(): void {
    if (!this.persistFile) return;
    let content: string;
    try {
      content = readFileSync(this.persistFile, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn(`[history] replay read failed (${code}): ${(error as Error).message}`);
      }
      return;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as SnapshotMetricsRow;
        if (typeof row?.timestampMs === "number") {
          pushRing(this.fastMetrics, row);
        } else {
          this.replayMalformedCount += 1;
        }
      } catch {
        this.replayMalformedCount += 1;
      }
    }
    if (this.replayMalformedCount > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[history] dropped ${this.replayMalformedCount} malformed rows during replay of ${this.persistFile}`);
    }
    if (this.fastMetrics.values.length > 0) {
      this.lastSlowFlushAt = this.fastMetrics.values.at(-1)!.timestampMs;
    }
  }

  private disablePersistence(reason: string): void {
    // Closing the fd avoids leaking it across the rest of process lifetime.
    if (this.persistFd !== undefined) {
      try {
        closeSync(this.persistFd);
      } catch {
        /* best-effort */
      }
      this.persistFd = undefined;
    }
    this.persistFile = undefined;
    // eslint-disable-next-line no-console
    console.warn(`[history] persistence disabled after first write failure: ${reason}`);
  }

  private persistRow(row: SnapshotMetricsRow): void {
    if (this.persistFd === undefined) return;
    try {
      writeSync(this.persistFd, JSON.stringify(row) + "\n");
    } catch (error) {
      this.disablePersistence((error as Error).message);
    }
  }

  /** Close the persistence fd. Idempotent. */
  close(): void {
    if (this.persistFd !== undefined) {
      try {
        closeSync(this.persistFd);
      } catch {
        /* best-effort */
      }
      this.persistFd = undefined;
    }
  }

  /** Inspect persistence health for /api/healthz. */
  persistenceState(): { active: boolean; replayMalformed: number; file: string | undefined } {
    return {
      active: this.persistFd !== undefined,
      replayMalformed: this.replayMalformedCount,
      ...(this.persistFile ? { file: this.persistFile } : { file: undefined }),
    };
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
