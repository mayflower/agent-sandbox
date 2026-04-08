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
 * HTTP transport layer for communicating with the sandbox-router.
 *
 * All requests are annotated with the sandbox routing headers
 * (`X-Sandbox-ID`, `X-Sandbox-Namespace`, `X-Sandbox-Port`) so the
 * router can proxy them to the correct sandbox pod.
 */

import type { ConnectionStrategy } from "./connection.js";
import { K8sAgentSandboxError, type HealthzResult } from "./types.js";

// ---------------------------------------------------------------------------
// Response types (match the sandbox runtime's JSON shapes)
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// SandboxRouterClient
// ---------------------------------------------------------------------------

export class SandboxRouterClient {
  readonly #strategy: ConnectionStrategy;
  readonly #sandboxId: string;
  readonly #namespace: string;
  readonly #serverPort: number;

  constructor(
    strategy: ConnectionStrategy,
    sandboxId: string,
    namespace: string,
    serverPort: number = 8888,
  ) {
    this.#strategy = strategy;
    this.#sandboxId = sandboxId;
    this.#namespace = namespace;
    this.#serverPort = serverPort;
  }

  async #request(
    method: string,
    endpoint: string,
    options?: {
      body?: BodyInit;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    await this.#strategy.verifyConnection();
    const baseUrl = await this.#strategy.connect();
    const url = `${baseUrl}/${endpoint}`;

    const headers: Record<string, string> = {
      "X-Sandbox-ID": this.#sandboxId,
      "X-Sandbox-Namespace": this.#namespace,
      "X-Sandbox-Port": String(this.#serverPort),
      ...options?.headers,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options?.body,
        signal: options?.signal,
      });
    } catch (err) {
      // Abort rejections from the caller's AbortSignal (notably
      // `AbortSignal.timeout`, which raises a `DOMException` with
      // `name === "TimeoutError"`) must reach higher layers with their
      // original identity so callers can distinguish a deliberate
      // per-command timeout from a genuine connectivity failure. Only
      // wrap errors that are NOT abort/timeout signals.
      if (
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        throw err;
      }
      throw new K8sAgentSandboxError(
        `Failed to connect to sandbox-router at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "CONNECTION_FAILED",
        err instanceof Error ? err : undefined,
      );
    }

    return response;
  }

  /**
   * Execute a shell command in the sandbox.
   */
  async execute(command: string, signal?: AbortSignal): Promise<ExecuteResult> {
    const response = await this.#request("POST", "execute", {
      body: JSON.stringify({ command }),
      headers: { "Content-Type": "application/json" },
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new K8sAgentSandboxError(
        `Execute request failed (HTTP ${response.status}): ${text}`,
        "HTTP_ERROR",
        undefined,
        response.status,
      );
    }

    // Read body as text first, then parse — avoids the consumed-body
    // problem if JSON.parse fails (e.g., proxy returning HTML).
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch (parseErr) {
      throw new K8sAgentSandboxError(
        `Execute response was not valid JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
        "HTTP_ERROR",
        parseErr instanceof Error ? parseErr : undefined,
        response.status,
      );
    }

    return {
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      exitCode: typeof body.exit_code === "number" ? body.exit_code : -1,
    };
  }

  /**
   * Download a file from the sandbox.
   *
   * The `relativePath` is relative to the sandbox working directory
   * (`/app`), e.g. `src/main.py`.
   */
  async download(relativePath: string): Promise<Uint8Array> {
    const encoded = encodeURIComponent(relativePath);
    const response = await this.#request("GET", `download/${encoded}`);

    // Carry the HTTP status on the error so callers branch on the
    // status (typed) instead of string-matching the message.
    if (response.status === 404) {
      throw new K8sAgentSandboxError(
        `File not found: ${relativePath}`,
        "FILE_OPERATION_FAILED",
        undefined,
        404,
      );
    }
    if (response.status === 403) {
      throw new K8sAgentSandboxError(
        `Access denied: ${relativePath}`,
        "FILE_OPERATION_FAILED",
        undefined,
        403,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new K8sAgentSandboxError(
        `Download failed (HTTP ${response.status}): ${text}`,
        "HTTP_ERROR",
        undefined,
        response.status,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  /**
   * Health check returning a discriminated union so callers can tell
   * "sandbox is unhealthy" apart from "we couldn't ask the question".
   *
   * The bare `boolean` form this replaces collapsed three failure modes
   * (network unreachable, HTTP error, programming bug) into a single
   * `false`, which is the textbook silent-failure pattern called out in
   * the project rules.
   */
  async healthzResult(): Promise<HealthzResult> {
    try {
      const ok = await this.healthCheck();
      if (ok) return { ok: true };
      // healthCheck() returned false without throwing means a non-ok
      // HTTP response — already wrapped as HTTP_ERROR by the caller
      // path, but the bare false fall-through here is defensive.
      return {
        ok: false,
        reason: "http-error",
        error: new K8sAgentSandboxError(
          "Health check returned non-200 without throwing",
          "HTTP_ERROR",
        ),
      };
    } catch (err) {
      const wrapped =
        err instanceof K8sAgentSandboxError
          ? err
          : new K8sAgentSandboxError(
              `Health check threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
              "HTTP_ERROR",
              err instanceof Error ? err : undefined,
            );
      const reason: HealthzResult & { ok: false } = {
        ok: false,
        reason:
          wrapped.code === "CONNECTION_FAILED" ||
          wrapped.code === "TUNNEL_FAILED" ||
          wrapped.code === "SANDBOX_NOT_REACHABLE"
            ? "unreachable"
            : wrapped.code === "COMMAND_TIMEOUT"
              ? "timeout"
              : wrapped.code === "HTTP_ERROR"
                ? "http-error"
                : "unknown",
        error: wrapped,
      };
      return reason;
    }
  }

  /**
   * Health check that throws on connection failure (used by
   * `initialize()` for diagnostic error messages).
   */
  async healthCheck(): Promise<boolean> {
    const response = await this.#request("GET", "");
    return response.ok;
  }

  async close(): Promise<void> {
    await this.#strategy.close();
  }
}
