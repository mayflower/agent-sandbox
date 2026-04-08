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

/* oxlint-disable no-instanceof/no-instanceof */
/**
 * Kubernetes Agent Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to connect to sandbox pods managed by the
 * k8s-agent-sandbox controller via the sandbox-router HTTP API.
 */

import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

import { K8sClient } from "./k8s-client.js";
import { createConnectionStrategy } from "./connection.js";
import { SandboxRouterClient } from "./http-client.js";
import {
  K8sAgentSandboxError,
  type K8sAgentSandboxOptions,
  type K8sAgentSandboxCreateOptions,
  type K8sConnectionConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** POSIX-safe single-quote escaping. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Convert a Uint8Array to base64. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------
// K8sAgentSandbox
// ---------------------------------------------------------------------------

export class K8sAgentSandbox extends BaseSandbox {
  #httpClient: SandboxRouterClient;
  #k8sClient: K8sClient | null;
  #sandboxId: string;
  #claimName: string | null;
  #namespace: string;
  #defaultTimeout: number;
  #deleteOnClose: boolean;
  #isRunning: boolean;

  get id(): string {
    return this.#sandboxId;
  }

  get isRunning(): boolean {
    return this.#isRunning;
  }

  get claimName(): string | null {
    return this.#claimName;
  }

  get namespace(): string {
    return this.#namespace;
  }

  /**
   * Construct a K8sAgentSandbox that connects to an existing sandbox.
   *
   * For most use cases, prefer the static factory methods:
   * - {@link K8sAgentSandbox.fromUrl} for direct URL connection
   * - {@link K8sAgentSandbox.create} for full lifecycle management
   * - {@link K8sAgentSandbox.fromExisting} to attach to an existing claim
   *
   * @param options - Connection and sandbox configuration.
   * @param k8sClient - Optional K8s client for lifecycle operations
   *   (required for gateway connections and deleteOnClose).
   */
  constructor(options: K8sAgentSandboxOptions, k8sClient?: K8sClient) {
    super();

    this.#sandboxId = options.sandboxId;
    this.#namespace = options.namespace ?? "default";
    this.#defaultTimeout = options.defaultTimeout ?? 300;
    this.#deleteOnClose = options.deleteOnClose ?? false;
    this.#claimName = options.claimName ?? null;
    this.#isRunning = false;
    this.#k8sClient = k8sClient ?? null;

    const serverPort = options.connectionConfig.serverPort ?? 8888;
    const strategy = createConnectionStrategy(
      options.connectionConfig,
      k8sClient,
    );
    this.#httpClient = new SandboxRouterClient(
      strategy,
      this.#sandboxId,
      this.#namespace,
      serverPort,
    );
  }

  /**
   * Initialize the connection and verify the sandbox is reachable.
   */
  async initialize(): Promise<void> {
    if (this.#isRunning) {
      throw new K8sAgentSandboxError(
        "Sandbox is already initialized",
        "ALREADY_INITIALIZED",
      );
    }

    // healthCheck() triggers strategy.connect() internally via #request
    try {
      const ok = await this.#httpClient.healthCheck();
      if (!ok) {
        throw new K8sAgentSandboxError(
          `Sandbox '${this.#sandboxId}' health check returned non-200`,
          "SANDBOX_NOT_REACHABLE",
        );
      }
    } catch (err) {
      if (err instanceof K8sAgentSandboxError) throw err;
      throw new K8sAgentSandboxError(
        `Cannot reach sandbox '${this.#sandboxId}': ${err instanceof Error ? err.message : String(err)}`,
        "SANDBOX_NOT_REACHABLE",
        err instanceof Error ? err : undefined,
      );
    }

    this.#isRunning = true;
  }

  // -----------------------------------------------------------------------
  // BaseSandbox abstract methods
  // -----------------------------------------------------------------------

  /**
   * Execute a shell command in the sandbox.
   *
   * Wrapped in `sh -c '...'` because the sandbox runtime uses
   * `subprocess.run()` with `shlex.split()`, so shell features
   * (pipes, redirects, subshells) are unavailable without wrapping.
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const wrapped = `sh -c ${shellQuote(command)}`;

    try {
      const signal =
        this.#defaultTimeout > 0
          ? AbortSignal.timeout(this.#defaultTimeout * 1000)
          : undefined;

      const result = await this.#httpClient.execute(wrapped, signal);

      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(result.stderr);

      return {
        output: parts.join("\n"),
        exitCode: result.exitCode,
        truncated: false,
      };
    } catch (err) {
      if (err instanceof K8sAgentSandboxError) throw err;
      // Distinguish AbortSignal.timeout firing from other failures so
      // callers (or LLMs reading the error) can decide whether to retry
      // with a longer timeout vs. give up.
      const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      if (isTimeout) {
        throw new K8sAgentSandboxError(
          `Execute timed out after ${this.#defaultTimeout}s: ${err.message}`,
          "COMMAND_TIMEOUT",
          err,
        );
      }
      throw new K8sAgentSandboxError(
        `Execute failed: ${err instanceof Error ? err.message : String(err)}`,
        "COMMAND_FAILED",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Upload files to the sandbox concurrently.
   *
   * Uses `execute()` with base64 encoding because the sandbox runtime's
   * `/upload` endpoint only supports flat filenames in `/app/`.
   *
   * @remarks Content is base64-encoded and piped through `execute()`,
   * so practical file size is limited by the sandbox runtime's command
   * buffer. For files larger than a few MB, consider chunked uploads.
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const uploadOne = async (
      filePath: string,
      content: Uint8Array,
    ): Promise<FileUploadResponse> => {
      const b64 = toBase64(content);
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));

      const cmd = dir
        ? `mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(filePath)}`
        : `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(filePath)}`;

      const result = await this.execute(cmd);

      return result.exitCode !== 0
        ? { path: filePath, error: "permission_denied" as FileOperationError }
        : { path: filePath, error: null };
    };

    const settled = await Promise.allSettled(
      files.map(([path, content]) => uploadOne(path, content)),
    );

    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const err = s.reason;
      if (
        err instanceof K8sAgentSandboxError &&
        (err.code === "CONNECTION_FAILED" || err.code === "HTTP_ERROR")
      ) {
        throw err;
      }
      return { path: files[i]![0], error: "invalid_path" as FileOperationError };
    });
  }

  /**
   * Download files from the sandbox concurrently.
   *
   * Uses the HTTP `/download/{path}` endpoint. Paths are converted from
   * absolute sandbox paths to paths relative to `/app` for the HTTP API.
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const downloadOne = async (
      filePath: string,
    ): Promise<FileDownloadResponse> => {
      let relativePath = filePath;
      if (relativePath.startsWith("/app/")) {
        relativePath = relativePath.slice(5);
      } else if (relativePath.startsWith("/")) {
        relativePath = relativePath.slice(1);
      }

      const content = await this.#httpClient.download(relativePath);
      return { path: filePath, content, error: null };
    };

    const settled = await Promise.allSettled(
      paths.map((p) => downloadOne(p)),
    );

    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const err = s.reason;
      if (err instanceof K8sAgentSandboxError) {
        if (err.code === "CONNECTION_FAILED" || err.code === "HTTP_ERROR") {
          throw err;
        }
        const error: FileOperationError = err.message.includes("Access denied")
          ? "permission_denied"
          : "file_not_found";
        return { path: paths[i]!, content: null, error };
      }
      throw err;
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Close the sandbox connection.
   *
   * If `deleteOnClose` was set, also deletes the SandboxClaim from the
   * cluster (which cascades to the Sandbox and Pod).
   */
  async close(): Promise<void> {
    this.#isRunning = false;

    if (this.#deleteOnClose && this.#claimName && this.#k8sClient) {
      try {
        await this.#k8sClient.deleteSandboxClaim(
          this.#claimName,
          this.#namespace,
        );
      } catch (err) {
        console.warn(
          `Failed to delete SandboxClaim '${this.#claimName}': ${err instanceof Error ? err.message : String(err)}. ` +
            `Manual cleanup: kubectl delete sandboxclaim ${this.#claimName} -n ${this.#namespace}`,
        );
      }
    }

    try {
      await this.#httpClient.close();
    } catch (err) {
      console.warn(
        `Failed to close HTTP client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async healthz(): Promise<boolean> {
    return this.#httpClient.healthz();
  }

  // -----------------------------------------------------------------------
  // Static factories
  // -----------------------------------------------------------------------

  /**
   * Connect directly to a sandbox via URL. No K8s client needed.
   */
  static fromUrl(
    baseUrl: string,
    sandboxId: string,
    options?: {
      namespace?: string;
      serverPort?: number;
      defaultTimeout?: number;
    },
  ): K8sAgentSandbox {
    return new K8sAgentSandbox({
      connectionConfig: {
        type: "direct",
        baseUrl,
        serverPort: options?.serverPort,
      },
      sandboxId,
      namespace: options?.namespace,
      defaultTimeout: options?.defaultTimeout,
    });
  }

  /**
   * Provision a new sandbox via the Kubernetes API.
   *
   * Creates a SandboxClaim, waits for the controller to start the
   * Sandbox, connects, and returns the initialized backend.
   */
  static async create(
    options: K8sAgentSandboxCreateOptions,
  ): Promise<K8sAgentSandbox> {
    const namespace = options.namespace ?? "default";
    const readyTimeout = options.sandboxReadyTimeout ?? 180;
    const deleteOnClose = options.deleteOnClose ?? true;
    const connectionConfig: K8sConnectionConfig = options.connectionConfig ?? {
      type: "tunnel",
      namespace,
    };

    const k8sClient = new K8sClient();
    const claimName = `sandbox-claim-${randomHex(8)}`;
    let sandbox: K8sAgentSandbox | null = null;

    try {
      await k8sClient.createSandboxClaim(claimName, options.template, namespace, {
        labels: options.labels,
      });

      const startTime = Date.now();
      const sandboxId = await k8sClient.resolveSandboxName(
        claimName,
        namespace,
        readyTimeout,
      );

      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(1, readyTimeout - elapsed);
      await k8sClient.waitForSandboxReady(sandboxId, namespace, remaining);

      sandbox = new K8sAgentSandbox(
        {
          connectionConfig,
          sandboxId,
          namespace,
          defaultTimeout: options.defaultTimeout,
          deleteOnClose,
          claimName,
        },
        k8sClient,
      );

      await sandbox.initialize();

      // Seed initial files if the caller requested them. This matches the
      // shape the deepagents-js shared sandbox test suite expects and lets
      // higher-level wrappers pre-populate the sandbox in a single call.
      if (options.initialFiles && Object.keys(options.initialFiles).length > 0) {
        const files: Array<[string, Uint8Array]> = Object.entries(
          options.initialFiles,
        ).map(([filePath, content]) => [
          filePath,
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content,
        ]);
        const uploadResults = await sandbox.uploadFiles(files);
        const failures = uploadResults.filter((r) => r.error !== null);
        if (failures.length > 0) {
          throw new K8sAgentSandboxError(
            `Failed to upload initialFiles: ${failures
              .map((r) => `${r.path} (${r.error})`)
              .join(", ")}`,
            "SANDBOX_CREATION_FAILED",
          );
        }
      }

      return sandbox;
    } catch (err) {
      // Tear down the tunnel subprocess first so we don't leak a
      // `kubectl port-forward` child process on the failure path.
      // sandbox.close() also deletes the claim when deleteOnClose
      // was set, which is why the outer cleanup below is best-effort
      // — a second delete against an already-gone claim 404s, which
      // the empty catch swallows without noise.
      if (sandbox !== null) {
        try {
          await sandbox.close();
        } catch {
          // best-effort tunnel teardown; the claim cleanup below
          // still runs as a safety net
        }
      }
      try {
        await k8sClient.deleteSandboxClaim(claimName, namespace);
      } catch (cleanupErr) {
        // If sandbox.close() already deleted the claim, this will
        // 404 and we intentionally ignore it. Only log when the
        // claim still exists and we couldn't remove it — which
        // realistically means the K8s API is unreachable, in which
        // case the user has bigger problems than a stale claim.
        if (sandbox === null) {
          console.warn(
            `Failed to clean up SandboxClaim '${claimName}' after creation failure: ` +
              `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}. ` +
              `Manual cleanup: kubectl delete sandboxclaim ${claimName} -n ${namespace}`,
          );
        }
      }
      if (err instanceof K8sAgentSandboxError) throw err;
      throw new K8sAgentSandboxError(
        `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
        "SANDBOX_CREATION_FAILED",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Attach to an existing SandboxClaim.
   */
  static async fromExisting(
    claimName: string,
    options?: {
      namespace?: string;
      connectionConfig?: K8sConnectionConfig;
      defaultTimeout?: number;
      deleteOnClose?: boolean;
      resolveTimeout?: number;
    },
  ): Promise<K8sAgentSandbox> {
    const namespace = options?.namespace ?? "default";
    const resolveTimeout = options?.resolveTimeout ?? 30;
    const connectionConfig: K8sConnectionConfig = options?.connectionConfig ?? {
      type: "tunnel",
      namespace,
    };

    const k8sClient = new K8sClient();
    const sandboxId = await k8sClient.resolveSandboxName(
      claimName,
      namespace,
      resolveTimeout,
    );

    const sandbox = new K8sAgentSandbox(
      {
        connectionConfig,
        sandboxId,
        namespace,
        defaultTimeout: options?.defaultTimeout,
        deleteOnClose: options?.deleteOnClose,
        claimName,
      },
      k8sClient,
    );

    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Delete SandboxClaims in the given namespace, filtered by labels.
   *
   * Only claims matching ALL of the given label key/value pairs are
   * deleted (translated to a Kubernetes `labelSelector` of the form
   * `k1=v1,k2=v2`). Pass a non-empty `labels` object unless you
   * explicitly opt in to namespace-wide deletion via
   * `options.confirmDeleteAll: true`.
   *
   * Without the confirmation flag, an empty `labels` object throws
   * `K8sAgentSandboxError("K8S_API_ERROR", ...)` rather than silently
   * deleting every claim in the namespace — that behavior was the
   * original pre-fix footgun and should never be hit by accident.
   *
   * @example Typical use from an integration test beforeAll hook
   * ```ts
   * await K8sAgentSandbox.deleteAll(
   *   { purpose: "integration-test", suite: "ci" },
   *   "default",
   * );
   * ```
   *
   * @example Opt in to namespace-wide deletion
   * ```ts
   * await K8sAgentSandbox.deleteAll({}, "scratch", { confirmDeleteAll: true });
   * ```
   */
  static async deleteAll(
    labels: Record<string, string>,
    namespace = "default",
    options?: { confirmDeleteAll?: boolean },
  ): Promise<void> {
    if (Object.keys(labels).length === 0 && !options?.confirmDeleteAll) {
      throw new K8sAgentSandboxError(
        "deleteAll refused: labels is empty. Pass a non-empty labels " +
          "record to filter, or pass `{ confirmDeleteAll: true }` to " +
          "explicitly delete every SandboxClaim in the namespace.",
        "K8S_API_ERROR",
      );
    }

    const k8sClient = new K8sClient();
    const claims = await k8sClient.listSandboxClaims(namespace, labels);

    const results = await Promise.allSettled(
      claims.map((claim) => k8sClient.deleteSandboxClaim(claim, namespace)),
    );

    const failed = results
      .map((r, i) => (r.status === "rejected" ? claims[i] : null))
      .filter((n): n is string => n !== null);

    if (failed.length > 0) {
      console.warn(
        `deleteAll: ${failed.length}/${claims.length} claims failed to delete: ${failed.join(", ")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
