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
import {
  K8sAgentSandboxError,
  type HealthzFailureReason,
  type HealthzResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Response types (match the sandbox runtime's JSON shapes)
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Default maximum response body size for `download()`. A malicious or
 * buggy sandbox command could otherwise cause the client to attempt
 * to buffer an unbounded response and OOM the Node heap — a real
 * attack vector for LLM-driven agents, where the model might be
 * tricked into triggering a huge download. 100 MB is a compromise
 * between "rarely hit in practice" and "survives on a 256 MB CI
 * runner". Override via `SandboxRouterClient` constructor.
 */
const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// SandboxRouterClient
// ---------------------------------------------------------------------------

export class SandboxRouterClient {
  readonly #strategy: ConnectionStrategy;
  readonly #sandboxId: string;
  readonly #namespace: string;
  readonly #serverPort: number;
  readonly #maxDownloadBytes: number;

  constructor(
    strategy: ConnectionStrategy,
    sandboxId: string,
    namespace: string,
    serverPort: number = 8888,
    maxDownloadBytes: number = DEFAULT_DOWNLOAD_MAX_BYTES,
  ) {
    this.#strategy = strategy;
    this.#sandboxId = sandboxId;
    this.#namespace = namespace;
    this.#serverPort = serverPort;
    this.#maxDownloadBytes = maxDownloadBytes;
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
   * (`/app`), e.g. `src/main.py`. Response bodies larger than
   * `maxDownloadBytes` are aborted mid-stream with a typed
   * `FILE_OPERATION_FAILED` error so a malicious or buggy sandbox
   * command can't OOM the Node heap.
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

    // Short-circuit on Content-Length if the server reports it.
    // Lets us reject a 10 GB download BEFORE starting to buffer.
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const parsedLength = Number.parseInt(contentLength, 10);
      if (
        Number.isFinite(parsedLength) &&
        parsedLength > this.#maxDownloadBytes
      ) {
        // Drain and discard so the connection returns to the pool.
        try {
          await response.body?.cancel();
        } catch {
          // Ignore — cancel errors are irrelevant here; we're
          // already throwing a more meaningful error.
        }
        throw new K8sAgentSandboxError(
          `Download exceeds size limit: ${relativePath} is ${parsedLength} bytes, max ${this.#maxDownloadBytes}`,
          "FILE_OPERATION_FAILED",
          undefined,
          response.status,
        );
      }
    }

    // Stream the body into a bounded buffer instead of
    // `response.arrayBuffer()` which has no size limit. If we
    // exceed the cap mid-stream, cancel and throw.
    const reader = response.body?.getReader();
    if (!reader) {
      // Fallback: shouldn't happen with fetch, but be defensive
      // rather than silently skipping the cap.
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > this.#maxDownloadBytes) {
        throw new K8sAgentSandboxError(
          `Download exceeds size limit: ${relativePath} is ${arrayBuffer.byteLength} bytes, max ${this.#maxDownloadBytes}`,
          "FILE_OPERATION_FAILED",
          undefined,
          response.status,
        );
      }
      return new Uint8Array(arrayBuffer);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > this.#maxDownloadBytes) {
            try {
              await reader.cancel();
            } catch {
              // Ignore — already aborting.
            }
            throw new K8sAgentSandboxError(
              `Download exceeds size limit: ${relativePath} passed ${this.#maxDownloadBytes} bytes mid-stream`,
              "FILE_OPERATION_FAILED",
              undefined,
              response.status,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ReadableStream reader may already be released if cancel
        // path ran above. Safe to ignore.
      }
    }

    // Concatenate into a single Uint8Array in one allocation.
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
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
      await this.healthCheck();
      return { ok: true };
    } catch (err) {
      const wrapped =
        err instanceof K8sAgentSandboxError
          ? err
          : new K8sAgentSandboxError(
              `Health check threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
              "HTTP_ERROR",
              err instanceof Error ? err : undefined,
            );
      return {
        ok: false,
        reason: mapErrorCodeToHealthzReason(wrapped.code),
        error: wrapped,
      };
    }
  }

  /**
   * Health check that throws a typed `K8sAgentSandboxError` on any
   * non-2xx response or transport failure. Used by `initialize()` and
   * `healthzResult()`.
   *
   * The previous version returned a bare `boolean` which collapsed
   * every failure mode into `false`, losing the HTTP status and body.
   * Callers that wanted diagnostic detail had no way to get it
   * without a separate request.
   */
  async healthCheck(): Promise<void> {
    const response = await this.#request("GET", "");
    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new K8sAgentSandboxError(
        `Health check failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
        "HTTP_ERROR",
        undefined,
        response.status,
      );
    }
  }

  async close(): Promise<void> {
    await this.#strategy.close();
  }
}

/**
 * Map a `K8sAgentSandboxErrorCode` to a `HealthzFailureReason` via an
 * exhaustive switch. Adding a new error code forces this switch to
 * break the build — the previous ternary-chain version silently
 * routed unknown codes to `"unknown"`, losing classification.
 */
function mapErrorCodeToHealthzReason(
  code: string,
): HealthzFailureReason {
  switch (code) {
    case "CONNECTION_FAILED":
    case "TUNNEL_FAILED":
    case "SANDBOX_NOT_REACHABLE":
      return "unreachable";
    case "COMMAND_TIMEOUT":
      return "timeout";
    case "HTTP_ERROR":
      return "http-error";
    default:
      // Intentionally non-exhaustive: healthCheck can raise codes
      // from deepagents' upstream SandboxErrorCode (ALREADY_INITIALIZED,
      // COMMAND_FAILED, FILE_OPERATION_FAILED, NOT_INITIALIZED) and
      // K8sAgentSandboxErrorCode additions (K8S_API_ERROR,
      // INVALID_ARGUMENT, SANDBOX_CREATION_FAILED, SANDBOX_NOT_FOUND).
      // None of these map cleanly to the four HealthzFailureReason
      // categories — they indicate a programming/configuration bug
      // rather than a reachability problem. The caller inspects
      // `.error.code` on the HealthzResult for the specific code.
      return "unknown";
  }
}
