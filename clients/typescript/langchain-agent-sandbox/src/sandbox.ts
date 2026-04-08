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
  type HealthzResult,
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
  #rootDir: string;

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

  get rootDir(): string {
    return this.#rootDir;
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
    // Normalize the root dir: must be absolute, no trailing slash
    // (except for "/" itself).
    const rawRoot = options.rootDir ?? "/app";
    if (!rawRoot.startsWith("/")) {
      throw new K8sAgentSandboxError(
        `rootDir must be an absolute path, got: ${rawRoot}`,
        "INVALID_ARGUMENT",
      );
    }
    this.#rootDir = rawRoot === "/" ? "/" : rawRoot.replace(/\/+$/, "");

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

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve a caller-supplied path against `rootDir`.
   *
   * Both `uploadFiles` and `downloadFiles` go through this so the
   * round-trip is symmetric: anything an LLM uploads to `/etc/x` ends
   * up at `<rootDir>/etc/x` and a subsequent download of `/etc/x`
   * fetches the same file. Without this, the upload would write to
   * the literal `/etc/x` while the download would resolve under
   * `rootDir` and silently miss the file the agent just wrote.
   *
   * Three cases:
   * 1. Path already under `rootDir` (e.g. `/app/foo` when rootDir is
   *    `/app`) — returned unchanged so the most common LLM input
   *    `<rootDir>/<file>` doesn't double-prefix to `/app/app/<file>`.
   * 2. Other absolute path (e.g. `/etc/foo`) — virtualized as
   *    `<rootDir>/etc/foo`. The user's "/" is treated as a virtual
   *    root that maps to rootDir, like a chroot.
   * 3. Relative path (e.g. `foo`) — resolved against `rootDir`
   *    directly.
   */
  #toAbsolutePath(filePath: string): string {
    // Case 1: already under rootDir.
    if (filePath === this.#rootDir) return filePath;
    if (this.#rootDir !== "/" && filePath.startsWith(this.#rootDir + "/")) {
      return filePath;
    }
    // Case 2: absolute path NOT under rootDir.
    if (filePath.startsWith("/")) {
      return this.#rootDir === "/"
        ? filePath
        : `${this.#rootDir}${filePath}`;
    }
    // Case 3: relative path.
    return this.#rootDir === "/"
      ? `/${filePath}`
      : `${this.#rootDir}/${filePath}`;
  }

  /**
   * Convert an absolute sandbox path to the relative form the
   * sandbox-router's `/download/{path}` endpoint expects (relative
   * to the runtime's working directory `/app`).
   */
  #toRouterDownloadPath(absolutePath: string): string {
    if (absolutePath.startsWith("/app/")) return absolutePath.slice(5);
    if (absolutePath === "/app") return "";
    if (absolutePath.startsWith("/")) return absolutePath.slice(1);
    return absolutePath;
  }

  /**
   * Throw `NOT_INITIALIZED` if the sandbox isn't ready for I/O.
   *
   * Called from every operation that talks to the sandbox runtime.
   * Without this, calling `execute`/`uploadFiles`/`downloadFiles`
   * before `initialize()` (or after `close()`) silently appears to
   * work right up until the first HTTP request, which then fails
   * with a confusing transport error instead of a typed precondition
   * violation.
   */
  #assertRunning(operation: string): void {
    if (!this.#isRunning) {
      throw new K8sAgentSandboxError(
        `Cannot ${operation}: sandbox is not initialized (call initialize() first, or use create()/fromExisting() which init automatically)`,
        "NOT_INITIALIZED",
      );
    }
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
   *
   * @param command The shell command to run.
   * @param options Optional per-call overrides.
   * @param options.timeout Per-call timeout in seconds. Overrides the
   *   sandbox's `defaultTimeout`. Pass `0` to disable the timeout for
   *   this call. The signature widening from the abstract
   *   `BaseSandbox.execute(command)` is permitted because the second
   *   parameter is optional — code that calls `execute(cmd)` continues
   *   to compile and behave identically. The widening matches
   *   `LangSmithSandbox.execute` precedent and lets an LLM extend its
   *   own timeout for known long-running tasks without reconstructing
   *   the sandbox.
   */
  async execute(
    command: string,
    options?: { timeout?: number },
  ): Promise<ExecuteResponse> {
    this.#assertRunning("execute");
    const effectiveTimeout = options?.timeout ?? this.#defaultTimeout;
    const wrapped = `sh -c ${shellQuote(command)}`;

    try {
      const signal =
        effectiveTimeout > 0
          ? AbortSignal.timeout(effectiveTimeout * 1000)
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
          `Execute timed out after ${effectiveTimeout}s: ${err.message}`,
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
    this.#assertRunning("upload files");
    const uploadOne = async (
      callerPath: string,
      content: Uint8Array,
    ): Promise<FileUploadResponse> => {
      // Virtualize against rootDir so the round-trip with downloadFiles
      // is symmetric. The caller-supplied `callerPath` is preserved on
      // the response so the caller can correlate inputs to outputs.
      const absolutePath = this.#toAbsolutePath(callerPath);
      const b64 = toBase64(content);
      const dir = absolutePath.substring(0, absolutePath.lastIndexOf("/"));

      const cmd = dir
        ? `mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(absolutePath)}`
        : `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(absolutePath)}`;

      const result = await this.execute(cmd);

      if (result.exitCode === 0) {
        return { path: callerPath, error: null };
      }
      // Distinguish the common file-write failure modes from the
      // generic exit-code-non-zero case. The previous version coerced
      // every non-zero exit to `permission_denied`, which sent agents
      // down the wrong remediation path for ENOSPC, missing parent
      // directory creation failures, base64 decode errors, etc.
      // FileOperationError is constrained to the four upstream codes;
      // we map to the most accurate one for each detected case.
      const stderr = result.output.toLowerCase();
      let error: FileOperationError;
      if (stderr.includes("permission denied") || stderr.includes("eacces")) {
        error = "permission_denied";
      } else if (stderr.includes("is a directory") || stderr.includes("eisdir")) {
        error = "is_directory";
      } else if (stderr.includes("no such file") || stderr.includes("enoent")) {
        error = "invalid_path";
      } else {
        // ENOSPC, base64 decode failure, runtime crash, etc. — none of
        // the four FileOperationError codes is a good fit. Log the
        // raw stderr so the operator can diagnose, and return
        // `invalid_path` as the least-misleading code (it doesn't
        // make the agent retry with elevated privileges, the way
        // `permission_denied` would).
        console.warn(
          `uploadFiles: unrecognized failure for '${callerPath}' (exit ${result.exitCode}): ${result.output.slice(0, 500)}`,
        );
        error = "invalid_path";
      }
      return { path: callerPath, error };
    };

    const settled = await Promise.allSettled(
      files.map(([path, content]) => uploadOne(path, content)),
    );

    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const err = s.reason;
      // Re-throw transport-level errors (CONNECTION_FAILED,
      // TUNNEL_FAILED, HTTP_ERROR) and precondition violations
      // (NOT_INITIALIZED) so the caller sees the actual problem
      // rather than a fake per-file error response. The previous
      // version flattened these to `invalid_path`, which sent
      // agents into a retry loop with a misleading remediation hint.
      if (err instanceof K8sAgentSandboxError) {
        if (
          err.code === "CONNECTION_FAILED" ||
          err.code === "TUNNEL_FAILED" ||
          err.code === "HTTP_ERROR" ||
          err.code === "NOT_INITIALIZED" ||
          err.code === "COMMAND_TIMEOUT"
        ) {
          throw err;
        }
      }
      // Genuinely unknown error path: log so an operator can diagnose.
      // FileOperationError doesn't have a generic "unknown" so we
      // fall back to `invalid_path` (least misleading — doesn't
      // suggest a privilege escalation retry).
      console.warn(
        `uploadFiles: unexpected error for '${files[i]![0]}': ${err instanceof Error ? err.message : String(err)}`,
      );
      return { path: files[i]![0], error: "invalid_path" as FileOperationError };
    });
  }

  /**
   * Download files from the sandbox concurrently.
   *
   * Paths are virtualized against `rootDir` (matching uploadFiles) so
   * the round-trip is symmetric. The runtime's `/download/{path}`
   * endpoint resolves paths relative to its working directory `/app`.
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    this.#assertRunning("download files");
    const downloadOne = async (
      callerPath: string,
    ): Promise<FileDownloadResponse> => {
      const absolutePath = this.#toAbsolutePath(callerPath);
      const routerPath = this.#toRouterDownloadPath(absolutePath);
      const content = await this.#httpClient.download(routerPath);
      return { path: callerPath, content, error: null };
    };

    const settled = await Promise.allSettled(
      paths.map((p) => downloadOne(p)),
    );

    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const err = s.reason;
      if (err instanceof K8sAgentSandboxError) {
        // Re-throw transport-level errors so the caller sees the
        // real problem instead of a per-file `file_not_found`.
        if (
          err.code === "CONNECTION_FAILED" ||
          err.code === "TUNNEL_FAILED" ||
          err.code === "HTTP_ERROR" ||
          err.code === "NOT_INITIALIZED"
        ) {
          throw err;
        }
        // Use the typed httpStatus instead of string-matching the
        // message. The previous `err.message.includes("Access denied")`
        // check was one rename away from silently degrading every 403
        // to `file_not_found`.
        let error: FileOperationError;
        if (err.httpStatus === 403) {
          error = "permission_denied";
        } else if (err.httpStatus === 404) {
          error = "file_not_found";
        } else {
          // FileOperationError lacks a generic "unknown" code; log
          // the underlying detail and use `file_not_found` as the
          // least-misleading fallback (the agent will check
          // existence rather than retrying with elevated privileges).
          console.warn(
            `downloadFiles: unrecognized failure for '${paths[i]}' (httpStatus=${err.httpStatus}): ${err.message}`,
          );
          error = "file_not_found";
        }
        return { path: paths[i]!, content: null, error };
      }
      // Non-K8sAgentSandboxError rejection — preserve as a generic
      // failure rather than re-throwing (re-throwing would drop the
      // partial successes from the rest of the batch).
      console.warn(
        `downloadFiles: unexpected error for '${paths[i]}': ${err instanceof Error ? err.message : String(err)}`,
      );
      return { path: paths[i]!, content: null, error: "file_not_found" };
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
   *
   * Cleanup errors (failed claim delete, failed tunnel teardown) are
   * collected and re-thrown as an `AggregateError` so neither leak is
   * silent. Pass `{ throwOnError: false }` to opt back into the old
   * "best-effort, log-only" behavior — useful for shutdown handlers
   * where surfacing the error is less important than completing the
   * teardown chain.
   *
   * Regardless of which mode is used, `isRunning` is set to `false`
   * before cleanup runs so subsequent operations fail fast with
   * `NOT_INITIALIZED` rather than attempting transport against a
   * half-closed sandbox.
   */
  async close(options?: { throwOnError?: boolean }): Promise<void> {
    const throwOnError = options?.throwOnError ?? true;
    this.#isRunning = false;

    const errors: Error[] = [];

    if (this.#deleteOnClose && this.#claimName && this.#k8sClient) {
      try {
        await this.#k8sClient.deleteSandboxClaim(
          this.#claimName,
          this.#namespace,
        );
      } catch (err) {
        const wrapped =
          err instanceof Error ? err : new Error(String(err));
        if (throwOnError) {
          errors.push(wrapped);
        } else {
          console.warn(
            `Failed to delete SandboxClaim '${this.#claimName}': ${wrapped.message}. ` +
              `Manual cleanup: kubectl delete sandboxclaim ${this.#claimName} -n ${this.#namespace}`,
          );
        }
      }
    }

    try {
      await this.#httpClient.close();
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (throwOnError) {
        errors.push(wrapped);
      } else {
        console.warn(`Failed to close HTTP client: ${wrapped.message}`);
      }
    }

    if (errors.length > 0) {
      // Single-error case is more ergonomic as the original error.
      if (errors.length === 1) {
        throw new K8sAgentSandboxError(
          `K8sAgentSandbox.close failed: ${errors[0]!.message}`,
          "K8S_API_ERROR",
          errors[0],
        );
      }
      throw new AggregateError(
        errors,
        `K8sAgentSandbox.close failed with ${errors.length} errors`,
      );
    }
  }

  /**
   * Health check returning a discriminated union.
   *
   * Returns `{ ok: true }` when the sandbox runtime responds 200, or
   * `{ ok: false, reason, error }` with the categorized failure mode
   * when it doesn't. The previous bare-`boolean` form collapsed three
   * different failure modes (network unreachable, HTTP 5xx, programming
   * bug) into a single `false`, leaving the caller unable to tell
   * "sandbox is unhealthy" apart from "we couldn't ask the question".
   */
  async healthz(): Promise<HealthzResult> {
    return this.#httpClient.healthzResult();
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
      rootDir?: string;
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
      rootDir: options?.rootDir,
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
          rootDir: options.rootDir,
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
      // Tear down the sandbox first if one was constructed — this
      // shuts down the tunnel subprocess AND deletes the claim when
      // deleteOnClose is true. We pass throwOnError:false because
      // surfacing a cleanup error during a creation-failure unwind
      // would mask the original creation error, which is almost
      // always more useful for debugging than the secondary teardown
      // failure. Cleanup errors are still logged via console.warn
      // by close() in non-throwing mode.
      let claimCleanedUp = false;
      if (sandbox !== null) {
        try {
          await sandbox.close({ throwOnError: false });
          // sandbox.close() with deleteOnClose=true already deleted
          // the claim, so the outer cleanup below would be redundant.
          claimCleanedUp = deleteOnClose;
        } catch {
          // close() should not throw with throwOnError:false but be
          // defensive — fall through to the explicit claim cleanup.
        }
      }
      // Outer claim cleanup: only runs when sandbox.close() did NOT
      // already delete the claim (i.e. sandbox was never constructed,
      // OR deleteOnClose was disabled). The previous version had this
      // condition inverted as `if (sandbox === null)` AFTER the
      // unconditional cleanup, which meant the warn branch was
      // unreachable on the only path that needed it (sandbox
      // constructed but claim wasn't auto-deleted).
      if (!claimCleanedUp) {
        try {
          await k8sClient.deleteSandboxClaim(claimName, namespace);
        } catch (cleanupErr) {
          // 404 is silently ignored inside deleteSandboxClaim — if
          // we get here it's a non-404 failure that the operator
          // needs to know about so they can clean up manually.
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
      rootDir?: string;
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
        rootDir: options?.rootDir,
      },
      k8sClient,
    );

    // Wrap initialize() in a try/catch so a failure here (sandbox
    // unreachable, tunnel can't be established) doesn't leave the
    // tunnel subprocess running. The previous version constructed
    // the sandbox (which spawned the tunnel for tunnel-mode) and
    // then called initialize() — if initialize threw, the tunnel
    // child process leaked.
    try {
      await sandbox.initialize();
    } catch (initErr) {
      try {
        await sandbox.close({ throwOnError: false });
      } catch {
        // close() with throwOnError:false should not throw, but be
        // defensive — surface the original initErr regardless.
      }
      throw initErr;
    }
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
    options?: { confirmDeleteAll?: boolean; bestEffort?: boolean },
  ): Promise<void> {
    if (Object.keys(labels).length === 0 && !options?.confirmDeleteAll) {
      throw new K8sAgentSandboxError(
        "deleteAll refused: labels is empty. Pass a non-empty labels " +
          "record to filter, or pass `{ confirmDeleteAll: true }` to " +
          "explicitly delete every SandboxClaim in the namespace.",
        "INVALID_ARGUMENT",
      );
    }

    const k8sClient = new K8sClient();
    const claims = await k8sClient.listSandboxClaims(namespace, labels);

    const results = await Promise.allSettled(
      claims.map((claim) => k8sClient.deleteSandboxClaim(claim, namespace)),
    );

    const failures: Array<{ claim: string; error: Error }> = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const reason = r.reason;
        failures.push({
          claim: claims[i]!,
          error: reason instanceof Error ? reason : new Error(String(reason)),
        });
      }
    });

    if (failures.length === 0) return;

    // Default: throw an aggregated error so leaked claims aren't
    // silent in CI/test setups. Pass `bestEffort: true` to opt back
    // into the old log-only behavior — useful for "clean up
    // whatever you can before this run" pre-test hooks where the
    // remaining cleanup will catch leftovers next time.
    if (options?.bestEffort) {
      console.warn(
        `deleteAll: ${failures.length}/${claims.length} claims failed to delete: ${failures.map((f) => `${f.claim} (${f.error.message})`).join("; ")}`,
      );
      return;
    }

    if (failures.length === 1) {
      throw new K8sAgentSandboxError(
        `deleteAll: failed to delete '${failures[0]!.claim}': ${failures[0]!.error.message}`,
        "K8S_API_ERROR",
        failures[0]!.error,
      );
    }
    throw new AggregateError(
      failures.map((f) => f.error),
      `deleteAll: ${failures.length}/${claims.length} claims failed to delete: ${failures.map((f) => f.claim).join(", ")}`,
    );
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
