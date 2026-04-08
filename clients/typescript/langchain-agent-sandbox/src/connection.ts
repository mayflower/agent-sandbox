// Copyright 2026 The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Connection strategies for reaching the sandbox-router service.
 *
 * - Direct: user provides a known base URL
 * - Gateway: discover IP from a Kubernetes Gateway resource
 * - Tunnel: kubectl port-forward to sandbox-router-svc
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { K8sClient } from "./k8s-client.js";
import {
  K8sAgentSandboxError,
  type K8sConnectionConfig,
  type K8sDirectConnectionConfig,
  type K8sGatewayConnectionConfig,
  type K8sTunnelConnectionConfig,
} from "./types.js";

const ROUTER_SERVICE_NAME = "svc/sandbox-router-svc";

// ---------------------------------------------------------------------------
// ConnectionStrategy interface
// ---------------------------------------------------------------------------

export interface ConnectionStrategy {
  /** Establishes the connection and returns the base URL. */
  connect(): Promise<string>;
  /** Releases any resources (child processes, etc.). */
  close(): Promise<void>;
  /** Checks health; throws if the connection is dead. */
  verifyConnection(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Direct
// ---------------------------------------------------------------------------

export class DirectConnectionStrategy implements ConnectionStrategy {
  readonly #baseUrl: string;

  constructor(config: K8sDirectConnectionConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async connect(): Promise<string> {
    return this.#baseUrl;
  }

  async close(): Promise<void> {}

  async verifyConnection(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class GatewayConnectionStrategy implements ConnectionStrategy {
  readonly #k8sClient: K8sClient;
  readonly #gatewayName: string;
  readonly #gatewayNamespace: string;
  readonly #timeout: number;
  #baseUrl: string | null = null;

  constructor(config: K8sGatewayConnectionConfig, k8sClient: K8sClient) {
    this.#k8sClient = k8sClient;
    this.#gatewayName = config.gatewayName;
    this.#gatewayNamespace = config.gatewayNamespace ?? "default";
    this.#timeout = config.gatewayReadyTimeout ?? 180;
  }

  async connect(): Promise<string> {
    if (this.#baseUrl) return this.#baseUrl;

    const ip = await this.#k8sClient.waitForGatewayIp(
      this.#gatewayName,
      this.#gatewayNamespace,
      this.#timeout,
    );
    this.#baseUrl = `http://${ip}`;
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    this.#baseUrl = null;
  }

  async verifyConnection(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Tunnel (kubectl port-forward)
// ---------------------------------------------------------------------------

export class TunnelConnectionStrategy implements ConnectionStrategy {
  readonly #namespace: string;
  readonly #portForwardReadyTimeout: number;
  #process: ChildProcess | null = null;
  #baseUrl: string | null = null;
  #localPort: number | null = null;
  /**
   * Captures spawn-time errors (e.g. ENOENT when `kubectl` is not on
   * PATH). Without an explicit `error` listener, Node would crash the
   * entire process on a spawn failure during `connect()`. We attach
   * a listener immediately after spawn and reuse the captured value
   * to surface a typed error.
   */
  #spawnError: Error | null = null;
  /**
   * Set by the `exit` listener so subsequent `verifyConnection()` and
   * `connect()` calls can detect a tunnel that died after the initial
   * handshake (k8s API server lost the watch, pod evicted, network
   * partition). Without this, a dead tunnel only surfaces on the next
   * HTTP attempt as a generic ECONNREFUSED.
   */
  #exited: boolean = false;
  /**
   * Set by `close()`. Once true, `connect()` refuses to spawn a new
   * tunnel and rejects with TUNNEL_FAILED — prevents the
   * "close() races with an in-flight execute()" resurrection case
   * where a paused request's `connect()` call would resurrect the
   * tunnel after the caller believed teardown was complete.
   */
  #closed: boolean = false;
  /**
   * In-flight `connect()` promise for concurrency memoization. Without
   * this, two parallel `execute()` calls on a fresh sandbox both enter
   * `connect()`, both spawn a kubectl subprocess, and the first
   * subprocess becomes orphaned with no handle (last-write-wins on
   * `#process`). Sharing a single in-flight promise fixes this.
   */
  #connectPromise: Promise<string> | null = null;
  /**
   * Buffered stderr from the spawned process, capped at
   * `#STDERR_BUFFER_MAX` bytes. Collected via a `data` listener
   * (not `for await` of `process.stderr`) so we can inspect it from
   * `verifyConnection()` without consuming the stream and starving
   * subsequent reads. The cap prevents an unbounded memory leak when
   * `kubectl port-forward` enters a retry loop and emits stderr
   * indefinitely — without it, a long-running sandbox could
   * accumulate megabytes of "error copying from local connection to
   * remote address" lines across the lifetime of the tunnel.
   */
  #stderrBuffer: string = "";
  static readonly #STDERR_BUFFER_MAX = 64 * 1024;

  constructor(config: K8sTunnelConnectionConfig) {
    // Prefer `routerNamespace`; fall back to the deprecated
    // `namespace` alias; default to "default". Splitting these out
    // makes it possible for the sandbox's own namespace (in
    // `K8sAgentSandboxOptions.namespace`) to differ from the
    // sandbox-router-svc namespace.
    this.#namespace =
      config.routerNamespace ?? config.namespace ?? "default";
    this.#portForwardReadyTimeout = config.portForwardReadyTimeout ?? 30;
  }

  async connect(): Promise<string> {
    // Reject post-close — prevents the "close() races with in-flight
    // execute()" resurrection case where a paused request's
    // connect() call would respawn the kubectl subprocess after the
    // caller believed teardown was complete, leaking a tunnel
    // subprocess forever.
    if (this.#closed) {
      throw new K8sAgentSandboxError(
        "Tunnel connection strategy is closed",
        "TUNNEL_FAILED",
      );
    }
    // Share a single in-flight connect() promise so concurrent
    // callers don't race to spawn separate kubectl subprocesses.
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#doConnect().catch((err) => {
      // On failure clear the memoized promise so a retry can try
      // again with a fresh spawn.
      this.#connectPromise = null;
      throw err;
    });
    return this.#connectPromise;
  }

  async #doConnect(): Promise<string> {
    // Re-use existing connection if still alive AND port still reachable.
    // The exitCode check alone is insufficient: a tunnel can be up at
    // the process level but the underlying TCP forward can be dead
    // (k8s API watch lost, pod evicted). Re-probing the port catches
    // that case and forces a reconnect.
    if (
      this.#baseUrl &&
      this.#process &&
      this.#process.exitCode === null &&
      !this.#exited &&
      this.#localPort !== null &&
      (await this.#isPortReachable(this.#localPort))
    ) {
      return this.#baseUrl;
    }

    // Clean up any dead/stale process. Do NOT set #closed — this is
    // an internal cleanup, not a user-initiated close.
    if (this.#process) {
      await this.#teardownProcess();
    }

    // Reset state for a fresh attempt
    this.#spawnError = null;
    this.#exited = false;
    this.#stderrBuffer = "";

    // Find a free port
    this.#localPort = await this.#getFreePort();

    // Start kubectl port-forward.
    let proc: ChildProcess;
    try {
      proc = spawn(
        "kubectl",
        [
          "port-forward",
          ROUTER_SERVICE_NAME,
          `${this.#localPort}:8080`,
          "-n",
          this.#namespace,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      // `spawn` itself can throw on Windows or when the system runs out
      // of file descriptors. Wrap as TUNNEL_FAILED so the caller can
      // distinguish from a generic CONNECTION_FAILED.
      throw new K8sAgentSandboxError(
        `Failed to spawn kubectl port-forward: ${err instanceof Error ? err.message : String(err)}`,
        "TUNNEL_FAILED",
        err instanceof Error ? err : undefined,
      );
    }
    this.#process = proc;

    // Critical: attach an error listener BEFORE the spawn finishes
    // resolving. Without this, an `error` event (e.g. ENOENT for
    // missing kubectl) becomes an unhandled `error` event and crashes
    // the Node process.
    proc.on("error", (err) => {
      this.#spawnError = err;
      this.#exited = true;
    });
    // Track exit so verifyConnection() can detect post-handshake death.
    proc.on("exit", () => {
      this.#exited = true;
    });
    // Buffer stderr non-destructively so we can read it from
    // verifyConnection() without racing the close path. Cap the
    // buffer at #STDERR_BUFFER_MAX bytes by truncating from the
    // FRONT — the most recent stderr is the most diagnostic for
    // "what just broke", so the tail is what we keep.
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.#stderrBuffer += chunk.toString("utf-8");
      if (
        this.#stderrBuffer.length > TunnelConnectionStrategy.#STDERR_BUFFER_MAX
      ) {
        // Slice to the last STDERR_BUFFER_MAX chars and prepend a
        // marker so the consumer knows the head was dropped.
        this.#stderrBuffer =
          "[...stderr truncated...]\n" +
          this.#stderrBuffer.slice(
            -TunnelConnectionStrategy.#STDERR_BUFFER_MAX,
          );
      }
    });

    // Wait for the port to become reachable
    const startTime = Date.now();
    const timeoutMs = this.#portForwardReadyTimeout * 1000;

    while (Date.now() - startTime < timeoutMs) {
      // Check spawn-time error first (ENOENT etc.). Capture the
      // message + the error object BEFORE awaiting close() — TS's
      // control-flow analysis invalidates narrowing through awaits
      // even for local consts in some configurations, so we pull
      // the values out of the field once and reuse them.
      if (this.#spawnError !== null) {
        const capturedSpawnErr: Error = this.#spawnError;
        const capturedMessage = capturedSpawnErr.message;
        await this.#teardownProcess();
        throw new K8sAgentSandboxError(
          `kubectl port-forward could not be spawned: ${capturedMessage}` +
            (capturedMessage.includes("ENOENT")
              ? " (is `kubectl` on $PATH?)"
              : ""),
          "TUNNEL_FAILED",
          capturedSpawnErr,
        );
      }

      // Check if process died after spawning
      if (this.#exited || proc.exitCode !== null) {
        const stderr = this.#stderrBuffer.trim() || "(empty stderr)";
        await this.#teardownProcess();
        throw new K8sAgentSandboxError(
          `kubectl port-forward crashed before becoming reachable: ${stderr}`,
          "TUNNEL_FAILED",
        );
      }

      // Try to connect
      const reachable = await this.#isPortReachable(this.#localPort);
      if (reachable) {
        this.#baseUrl = `http://127.0.0.1:${this.#localPort}`;
        return this.#baseUrl;
      }

      await sleep(500);
    }

    const stderr = this.#stderrBuffer.trim();
    await this.#teardownProcess();
    throw new K8sAgentSandboxError(
      `Failed to establish kubectl port-forward tunnel within ${this.#portForwardReadyTimeout}s` +
        (stderr ? `; stderr: ${stderr}` : ""),
      "TUNNEL_FAILED",
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#connectPromise = null;
    await this.#teardownProcess();
  }

  /**
   * Tear down the current kubectl subprocess, if any. Distinct from
   * the public `close()` — this does not set `#closed`, so internal
   * cleanup during a reconnect attempt doesn't permanently disable
   * the strategy.
   *
   * Throws `TUNNEL_FAILED` on non-ESRCH kill errors (e.g. EPERM from
   * AppArmor/SELinux) and keeps `#process` set so a retry can finish
   * the kill. The previous version logged via `console.warn` and
   * nulled the handle in `finally`, leaking a zombie subprocess that
   * no subsequent close() could reach.
   */
  async #teardownProcess(): Promise<void> {
    if (!this.#process) return;
    const proc = this.#process;
    // Short-circuit: if the subprocess already exited, skip the
    // 2000ms Promise.race and go straight to state reset. The
    // previous unconditional wait added a mandatory 2s stall to
    // every close() on a dead process.
    const alreadyExited = this.#exited || proc.exitCode !== null;
    let killError: unknown;
    if (!alreadyExited) {
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        killError = err;
      }
      if (killError === undefined) {
        // Wait for graceful exit up to 2000ms. Use `once` so the
        // listener self-removes; previous `on` variant attached a
        // new listener per close() call and relied on
        // `#process = null` in finally to GC it.
        await Promise.race([
          new Promise<void>((resolve) => {
            proc.once("exit", () => resolve());
          }),
          sleep(2000),
        ]);
        if (proc.exitCode === null && !this.#exited) {
          try {
            proc.kill("SIGKILL");
          } catch (err) {
            killError = err;
          }
        }
      }
    }

    if (killError !== undefined) {
      const code = (killError as NodeJS.ErrnoException)?.code;
      if (code !== "ESRCH") {
        // Non-ESRCH kill failure means the subprocess may still be
        // alive. Do NOT null #process — a retry can finish the kill.
        // Surface as a typed error so the caller isn't silently
        // lied to about teardown success.
        throw new K8sAgentSandboxError(
          `Failed to kill kubectl port-forward subprocess (pid=${proc.pid}): ${killError instanceof Error ? killError.message : String(killError)}` +
            ". The subprocess may still be running; retrying close() will attempt the kill again.",
          "TUNNEL_FAILED",
          killError instanceof Error ? killError : undefined,
        );
      }
      // ESRCH: process is already gone. Fall through to state reset.
    }

    // Success path: clear all tunnel state.
    this.#process = null;
    this.#baseUrl = null;
    this.#localPort = null;
    this.#exited = false;
    this.#spawnError = null;
    this.#stderrBuffer = "";
  }

  async verifyConnection(): Promise<void> {
    // Spawn-time error captured by the `error` listener.
    const spawnErr: Error | null = this.#spawnError;
    if (spawnErr !== null) {
      await this.#teardownProcess();
      throw new K8sAgentSandboxError(
        `kubectl port-forward subprocess errored: ${spawnErr.message}`,
        "TUNNEL_FAILED",
        spawnErr,
      );
    }
    // Process died after the initial handshake.
    if (this.#process && (this.#exited || this.#process.exitCode !== null)) {
      const stderr = this.#stderrBuffer.trim() || "(empty stderr)";
      await this.#teardownProcess();
      throw new K8sAgentSandboxError(
        `kubectl port-forward died: ${stderr}`,
        "TUNNEL_FAILED",
      );
    }
    // Process is alive but the underlying TCP forward may be dead
    // (lost watch, pod evicted, network partition). Probe the local
    // port to confirm. If unreachable, tear down so the next request
    // gets a fresh tunnel via `connect()`.
    if (this.#process && this.#localPort !== null) {
      const reachable = await this.#isPortReachable(this.#localPort);
      if (!reachable) {
        await this.#teardownProcess();
        throw new K8sAgentSandboxError(
          `kubectl port-forward is alive but the local port ${this.#localPort} is not reachable; tunnel will be re-established on next call`,
          "TUNNEL_FAILED",
        );
      }
    }
  }

  async #getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Could not determine port")));
        }
      });
      server.on("error", reject);
    });
  }

  #isPortReachable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      // 500ms is more forgiving than the previous 100ms which produced
      // false negatives on slow CI hosts. Still tight enough that the
      // 30s outer loop completes within budget.
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the appropriate connection strategy from a config object.
 *
 * @param k8sClient Required for gateway strategy; ignored for direct/tunnel.
 */
export function createConnectionStrategy(
  config: K8sConnectionConfig,
  k8sClient?: K8sClient,
): ConnectionStrategy {
  switch (config.type) {
    case "direct":
      return new DirectConnectionStrategy(config);
    case "gateway":
      if (!k8sClient) {
        throw new K8sAgentSandboxError(
          "Gateway connection requires a K8sClient instance",
          "CONNECTION_FAILED",
        );
      }
      return new GatewayConnectionStrategy(config, k8sClient);
    case "tunnel":
      return new TunnelConnectionStrategy(config);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
