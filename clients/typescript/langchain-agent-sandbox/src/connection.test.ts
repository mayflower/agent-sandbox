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

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DirectConnectionStrategy,
  GatewayConnectionStrategy,
  TunnelConnectionStrategy,
  createConnectionStrategy,
} from "./connection.js";
import { K8sAgentSandboxError } from "./types.js";
import type { K8sClient } from "./k8s-client.js";

describe("DirectConnectionStrategy", () => {
  it("should return the base URL", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    const url = await strategy.connect();
    expect(url).toBe("http://localhost:8080");
  });

  it("should strip trailing slashes", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080///",
    });
    const url = await strategy.connect();
    expect(url).toBe("http://localhost:8080");
  });

  it("should be idempotent", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    await strategy.connect();
    await strategy.close();
    const url = await strategy.connect();
    expect(url).toBe("http://localhost:8080");
  });

  it("should not throw on verify or close", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    await expect(strategy.verifyConnection()).resolves.toBeUndefined();
    await expect(strategy.close()).resolves.toBeUndefined();
  });
});

describe("GatewayConnectionStrategy", () => {
  let mockK8sClient: K8sClient;

  beforeEach(() => {
    mockK8sClient = {
      waitForGatewayIp: vi.fn().mockResolvedValue("34.56.78.90"),
    } as unknown as K8sClient;
  });

  it("should discover gateway IP and return URL", async () => {
    const strategy = new GatewayConnectionStrategy(
      { type: "gateway", gatewayName: "my-gw" },
      mockK8sClient,
    );
    const url = await strategy.connect();
    expect(url).toBe("http://34.56.78.90");
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledWith(
      "my-gw",
      "default",
      180,
    );
  });

  it("should cache the URL on subsequent calls", async () => {
    const strategy = new GatewayConnectionStrategy(
      { type: "gateway", gatewayName: "my-gw" },
      mockK8sClient,
    );
    await strategy.connect();
    await strategy.connect();
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledTimes(1);
  });

  it("should clear cached URL on close", async () => {
    const strategy = new GatewayConnectionStrategy(
      { type: "gateway", gatewayName: "my-gw" },
      mockK8sClient,
    );
    await strategy.connect();
    await strategy.close();
    await strategy.connect();
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledTimes(2);
  });

  it("should use custom namespace and timeout", async () => {
    const strategy = new GatewayConnectionStrategy(
      {
        type: "gateway",
        gatewayName: "gw-prod",
        gatewayNamespace: "infra",
        gatewayReadyTimeout: 60,
      },
      mockK8sClient,
    );
    await strategy.connect();
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledWith(
      "gw-prod",
      "infra",
      60,
    );
  });
});

describe("TunnelConnectionStrategy", () => {
  // Configuration-level checks (preserved from the original suite).
  it("should use default namespace", () => {
    const strategy = new TunnelConnectionStrategy({ type: "tunnel" });
    expect(strategy).toBeInstanceOf(TunnelConnectionStrategy);
  });

  it("should accept custom namespace and timeout", () => {
    const strategy = new TunnelConnectionStrategy({
      type: "tunnel",
      namespace: "sandbox-ns",
      portForwardReadyTimeout: 60,
    });
    expect(strategy).toBeInstanceOf(TunnelConnectionStrategy);
  });

  it("close should be safe when no process is running", async () => {
    const strategy = new TunnelConnectionStrategy({ type: "tunnel" });
    await expect(strategy.close()).resolves.toBeUndefined();
  });

  it("verifyConnection should be safe when no process is running", async () => {
    const strategy = new TunnelConnectionStrategy({ type: "tunnel" });
    await expect(strategy.verifyConnection()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TunnelConnectionStrategy.connect() — full subprocess lifecycle tests
//
// These tests mock node:child_process.spawn and node:net.createConnection
// so the four critical branches in connect() are exercised at the unit
// layer instead of being only reachable through the int suite (which
// requires a real cluster + kubectl). The matrix covered:
//   1. Happy connect: spawn succeeds, port becomes reachable on first poll
//   2. Spawn-time error (ENOENT — kubectl not on PATH)
//   3. Process exits before becoming reachable (port-forward connection
//      refused; surfaces stderr in the typed error)
//   4. Re-use of existing alive tunnel skips a fresh spawn
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";

const mockSpawn = vi.fn();
const mockCreateConnection = vi.fn();
const mockCreateServer = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("node:net", () => ({
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
  createServer: (...args: unknown[]) => mockCreateServer(...args),
}));

/**
 * A minimal ChildProcess stand-in. The real `kubectl port-forward`
 * subprocess is replaced by this so we can drive `error`/`exit`
 * events deterministically and inspect the listeners attached by
 * `connect()`.
 */
class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  killed: boolean = false;
  stderr: EventEmitter & { on: EventEmitter["on"] };

  constructor() {
    super();
    this.stderr = new EventEmitter();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (this.exitCode === null) {
      this.exitCode = 143; // SIGTERM
      // Defer the exit event by a tick to mimic real subprocess
      // teardown timing.
      setImmediate(() => this.emit("exit", this.exitCode));
    }
    return true;
  }

  // Simulate a spawn-time error (ENOENT etc.).
  emitError(err: Error) {
    this.emit("error", err);
  }

  // Simulate the subprocess exiting on its own (e.g. kubectl ran into
  // an error after spawn).
  emitExit(code: number, stderr?: string) {
    if (stderr !== undefined) this.stderr.emit("data", Buffer.from(stderr));
    this.exitCode = code;
    this.emit("exit", code);
  }
}

/**
 * Stand-in for `node:net.Socket` returned by `createConnection`. Lets
 * the test drive the `connect`, `error`, and `timeout` events that
 * `#isPortReachable` listens for.
 */
class FakeSocket extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  destroy(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setTimeout(_ms: number, _cb: () => void): void {}
}

/**
 * Stand-in for the server used by `#getFreePort`. Allocates a fixed
 * port deterministically.
 */
function makeFakeServer(port: number) {
  const server = new EventEmitter() as EventEmitter & {
    listen: (...args: unknown[]) => void;
    address: () => { port: number };
    close: (cb: () => void) => void;
  };
  server.listen = (_: unknown, __: unknown, cb: () => void) => {
    setImmediate(cb);
  };
  server.address = () => ({ port });
  server.close = (cb: () => void) => setImmediate(cb);
  return server;
}

describe("TunnelConnectionStrategy.connect (subprocess lifecycle)", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockCreateConnection.mockReset();
    mockCreateServer.mockReset();
    // Default: free-port allocator returns 12345
    mockCreateServer.mockImplementation(() => makeFakeServer(12345));
  });

  it("returns a base URL when the tunnel becomes reachable", async () => {
    mockSpawn.mockImplementation(() => new FakeChildProcess());

    // Reachability probe succeeds.
    mockCreateConnection.mockImplementation(
      (_opts: unknown, onConnect: () => void) => {
        const sock = new FakeSocket();
        setImmediate(onConnect);
        return sock;
      },
    );

    const strategy = new TunnelConnectionStrategy({
      type: "tunnel",
      namespace: "ns",
      portForwardReadyTimeout: 5,
    });

    const url = await strategy.connect();
    expect(url).toBe("http://127.0.0.1:12345");
    expect(mockSpawn).toHaveBeenCalledOnce();
    const args = mockSpawn.mock.calls[0]!;
    expect(args[0]).toBe("kubectl");
    expect(args[1]).toEqual([
      "port-forward",
      "svc/sandbox-router-svc",
      "12345:8080",
      "-n",
      "ns",
    ]);

    await strategy.close();
  });

  it("throws TUNNEL_FAILED with PATH hint when kubectl is missing (ENOENT)", async () => {
    // Schedule the spawn-error injection inside the mock so it
    // fires AFTER the strategy has attached its `error` listener
    // (which happens synchronously inside connect() right after
    // spawn returns). Without this ordering the EventEmitter would
    // raise an unhandled `error` event.
    mockSpawn.mockImplementation(() => {
      const proc = new FakeChildProcess();
      setImmediate(() => {
        proc.emitError(
          Object.assign(new Error("spawn kubectl ENOENT"), {
            code: "ENOENT",
          }),
        );
      });
      return proc;
    });
    mockCreateConnection.mockImplementation(() => {
      const sock = new FakeSocket();
      setImmediate(() => sock.emit("error", new Error("ECONNREFUSED")));
      return sock;
    });

    const strategy = new TunnelConnectionStrategy({
      type: "tunnel",
      portForwardReadyTimeout: 2,
    });

    await expect(strategy.connect()).rejects.toMatchObject({
      code: "TUNNEL_FAILED",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("throws TUNNEL_FAILED with stderr when kubectl exits before becoming reachable", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new FakeChildProcess();
      setImmediate(() => {
        proc.emitExit(
          1,
          "error: unable to forward port: connection refused",
        );
      });
      return proc;
    });
    mockCreateConnection.mockImplementation(() => {
      const sock = new FakeSocket();
      setImmediate(() => sock.emit("error", new Error("ECONNREFUSED")));
      return sock;
    });

    const strategy = new TunnelConnectionStrategy({
      type: "tunnel",
      portForwardReadyTimeout: 2,
    });

    await expect(strategy.connect()).rejects.toMatchObject({
      code: "TUNNEL_FAILED",
      message: expect.stringContaining("connection refused"),
    });
  });

  it("times out cleanly when the port never becomes reachable", async () => {
    let lastProc: FakeChildProcess | null = null;
    mockSpawn.mockImplementation(() => {
      lastProc = new FakeChildProcess();
      return lastProc;
    });
    mockCreateConnection.mockImplementation(() => {
      const sock = new FakeSocket();
      setImmediate(() => sock.emit("error", new Error("ECONNREFUSED")));
      return sock;
    });

    const strategy = new TunnelConnectionStrategy({
      type: "tunnel",
      // 1s timeout so the test runs fast. Still verifies the timeout
      // path tears down the subprocess.
      portForwardReadyTimeout: 1,
    });

    await expect(strategy.connect()).rejects.toMatchObject({
      code: "TUNNEL_FAILED",
      message: expect.stringContaining("Failed to establish"),
    });
    expect(lastProc).not.toBeNull();
    expect(lastProc!.killed).toBe(true);
  });

  it("re-uses the existing tunnel on a subsequent connect() call", async () => {
    mockSpawn.mockImplementation(() => new FakeChildProcess());
    // Always reachable.
    mockCreateConnection.mockImplementation(
      (_opts: unknown, onConnect: () => void) => {
        const sock = new FakeSocket();
        setImmediate(onConnect);
        return sock;
      },
    );

    const strategy = new TunnelConnectionStrategy({
      type: "tunnel",
      portForwardReadyTimeout: 5,
    });

    const first = await strategy.connect();
    const second = await strategy.connect();

    expect(first).toBe("http://127.0.0.1:12345");
    expect(second).toBe(first);
    // spawn should only have been called once across two connects.
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await strategy.close();
  });
});

describe("createConnectionStrategy", () => {
  it("should create DirectConnectionStrategy", () => {
    const strategy = createConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    expect(strategy).toBeInstanceOf(DirectConnectionStrategy);
  });

  it("should create GatewayConnectionStrategy with k8sClient", () => {
    const mockClient = {} as K8sClient;
    const strategy = createConnectionStrategy(
      { type: "gateway", gatewayName: "gw" },
      mockClient,
    );
    expect(strategy).toBeInstanceOf(GatewayConnectionStrategy);
  });

  it("should throw if gateway strategy has no k8sClient", () => {
    expect(() =>
      createConnectionStrategy({ type: "gateway", gatewayName: "gw" }),
    ).toThrow(K8sAgentSandboxError);
  });

  it("should create TunnelConnectionStrategy", () => {
    const strategy = createConnectionStrategy({ type: "tunnel" });
    expect(strategy).toBeInstanceOf(TunnelConnectionStrategy);
  });
});
