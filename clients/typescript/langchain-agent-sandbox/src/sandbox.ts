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

import * as posix from "node:path/posix";

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
  K8sFileDownloadBatchError,
  K8sFileUploadBatchError,
  type K8sAgentSandboxErrorCode,
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
  #runtimeWorkDir: string;

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

  get runtimeWorkDir(): string {
    return this.#runtimeWorkDir;
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
    // Normalize and validate runtimeWorkDir + rootDir.
    //
    // Both must be absolute paths. We run them through `posix.normalize`
    // to defang `..`/`.`/`//` segments — without this, an attacker (or
    // a buggy caller) could pass `rootDir: "//"` and the trailing-slash
    // strip would yield `""`, silently disabling the chroot. Or
    // `rootDir: "/app/.."` which would normalize to `/` and pass the
    // startsWith check trivially.
    //
    // After normalization, `rootDir` MUST be equal to or strictly
    // under `runtimeWorkDir`. The sandbox runtime image hard-pins its
    // own filesystem chroot to its working directory and refuses to
    // serve files outside it (the python-runtime-sandbox image
    // explicitly uses `os.path.realpath + commonpath` to enforce
    // this). A `rootDir` outside `runtimeWorkDir` would silently 403
    // every download with no signal to the caller.
    this.#runtimeWorkDir = K8sAgentSandbox.#normalizeAbsolutePath(
      options.runtimeWorkDir ?? "/app",
      "runtimeWorkDir",
    );
    this.#rootDir = K8sAgentSandbox.#normalizeAbsolutePath(
      options.rootDir ?? "/app",
      "rootDir",
    );
    if (
      this.#rootDir !== this.#runtimeWorkDir &&
      this.#runtimeWorkDir !== "/" &&
      !this.#rootDir.startsWith(this.#runtimeWorkDir + "/")
    ) {
      throw new K8sAgentSandboxError(
        `rootDir '${this.#rootDir}' must be equal to or under runtimeWorkDir '${this.#runtimeWorkDir}' — the sandbox runtime image refuses to serve files outside its working directory`,
        "INVALID_ARGUMENT",
      );
    }

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
   * Normalize a caller-supplied absolute path option (`rootDir` /
   * `runtimeWorkDir`) for storage in the field.
   *
   * Steps: must start with `/`, run through `posix.normalize` (which
   * collapses `..`, `.`, and `//` segments), then strip the trailing
   * slash unless the result is `/` itself. Throws `INVALID_ARGUMENT`
   * for empty input or non-absolute paths.
   */
  static #normalizeAbsolutePath(value: string, optionName: string): string {
    if (typeof value !== "string") {
      throw new K8sAgentSandboxError(
        `${optionName} must be a string, got: ${typeof value}`,
        "INVALID_ARGUMENT",
      );
    }
    if (value === "") {
      throw new K8sAgentSandboxError(
        `${optionName} must be a non-empty absolute path`,
        "INVALID_ARGUMENT",
      );
    }
    if (!value.startsWith("/")) {
      throw new K8sAgentSandboxError(
        `${optionName} must be an absolute path, got: ${value}`,
        "INVALID_ARGUMENT",
      );
    }
    // Reject NUL bytes and other ASCII control chars. NUL terminates
    // C strings (every shell, every libc, every filesystem layer),
    // so a caller-supplied path containing `\0` would be silently
    // truncated at the first NUL when passed through `sh -c '...'` —
    // an LLM writing to `/app/report\0attack.sh` would actually
    // write to `/app/report` and receive `{error: null}`. Newlines
    // and other control chars similarly corrupt shell escaping.
    if (/[\x00-\x1f]/.test(value)) {
      throw new K8sAgentSandboxError(
        `${optionName} must not contain ASCII control characters (got: ${JSON.stringify(value)})`,
        "INVALID_ARGUMENT",
      );
    }
    const normalized = posix.normalize(value);
    return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
  }

  /**
   * Resolve a caller-supplied path against `rootDir`, normalize away
   * any `..` segments, and reject the result if it escapes `rootDir`.
   *
   * Both `uploadFiles` and `downloadFiles` go through this so the
   * round-trip is symmetric: anything an LLM uploads to `/etc/x` ends
   * up at `<rootDir>/etc/x` and a subsequent download of `/etc/x`
   * fetches the same file. Without this, the upload would write to
   * the literal `/etc/x` while the download would resolve under
   * `rootDir` and silently miss the file the agent just wrote.
   *
   * Three input cases:
   * 1. Path already under `rootDir` (e.g. `/app/foo` when rootDir is
   *    `/app`) — kept as-is so the most common LLM input
   *    `<rootDir>/<file>` doesn't double-prefix to `/app/app/<file>`.
   * 2. Other absolute path (e.g. `/etc/foo`) — virtualized as
   *    `<rootDir>/etc/foo`. The user's "/" is treated as a virtual
   *    root that maps to rootDir, like a chroot.
   * 3. Relative path (e.g. `foo`) — resolved against `rootDir`
   *    directly.
   *
   * After resolution, the path is normalized (collapsing any `..`
   * segments) and verified to still be under `rootDir`. Without this
   * normalization step, an LLM input like `"../etc/passwd"` would
   * yield `/app/../etc/passwd` which the shell resolves to
   * `/etc/passwd` — escaping the chroot the docstring promises and
   * defeating the entire point of virtualization.
   */
  #toAbsolutePath(filePath: string): string {
    if (filePath === "") {
      throw new K8sAgentSandboxError(
        "filePath must not be empty",
        "INVALID_ARGUMENT",
      );
    }
    // Reject NUL bytes and other ASCII control chars for the same
    // reason #normalizeAbsolutePath does — a caller-supplied path
    // containing `\0` gets silently truncated at the first NUL by
    // every shell/libc/filesystem layer, so `/app/report\0attack.sh`
    // would really write `/app/report` while the per-file response
    // claimed success.
    if (/[\x00-\x1f]/.test(filePath)) {
      throw new K8sAgentSandboxError(
        `filePath must not contain ASCII control characters (got: ${JSON.stringify(filePath)})`,
        "INVALID_ARGUMENT",
      );
    }

    let resolved: string;
    if (filePath === this.#rootDir) {
      resolved = filePath;
    } else if (
      this.#rootDir !== "/" &&
      filePath.startsWith(this.#rootDir + "/")
    ) {
      // Already under rootDir.
      resolved = filePath;
    } else if (filePath.startsWith("/")) {
      // Absolute path NOT under rootDir — virtualize.
      resolved =
        this.#rootDir === "/" ? filePath : `${this.#rootDir}${filePath}`;
    } else {
      // Relative path.
      resolved =
        this.#rootDir === "/"
          ? `/${filePath}`
          : `${this.#rootDir}/${filePath}`;
    }

    // Normalize away `.` and `..` segments. posix.normalize("/app/../etc")
    // yields "/etc", which is then caught by the prefix check below.
    const normalized = posix.normalize(resolved);

    // Verify the normalized result is still under rootDir. Without
    // this check, `..` segments could escape the virtual root and
    // hit arbitrary paths on the sandbox filesystem.
    const isUnderRoot =
      normalized === this.#rootDir ||
      (this.#rootDir === "/"
        ? normalized.startsWith("/")
        : normalized.startsWith(this.#rootDir + "/"));
    if (!isUnderRoot) {
      throw new K8sAgentSandboxError(
        `path '${filePath}' escapes virtual root '${this.#rootDir}' after normalization (resolved to '${normalized}')`,
        "INVALID_ARGUMENT",
      );
    }
    return normalized;
  }

  /**
   * Convert a virtualized absolute path back to the form the
   * sandbox-router's `/download/{path}` endpoint expects (relative to
   * the runtime image's working directory).
   *
   * Because the constructor enforces `rootDir` is equal-to or under
   * `runtimeWorkDir`, every absolute path produced by `#toAbsolutePath`
   * is guaranteed to be under `runtimeWorkDir`. Stripping the prefix
   * is therefore always safe — no need for `posix.relative` or `..`
   * segments (which the runtime's path sanitizer rejects with 403).
   */
  #toRouterDownloadPath(absolutePath: string): string {
    if (absolutePath === this.#runtimeWorkDir) return "";
    if (this.#runtimeWorkDir === "/") {
      return absolutePath.slice(1);
    }
    // The constructor's rootDir-under-runtimeWorkDir check guarantees
    // this prefix relationship for any path #toAbsolutePath produces.
    // The defensive `else` exists only to satisfy the type checker;
    // hitting it means the constructor validation was bypassed or
    // someone called this with an arbitrary path.
    if (absolutePath.startsWith(this.#runtimeWorkDir + "/")) {
      return absolutePath.slice(this.#runtimeWorkDir.length + 1);
    }
    throw new K8sAgentSandboxError(
      `internal error: path '${absolutePath}' is not under runtimeWorkDir '${this.#runtimeWorkDir}'`,
      "INVALID_ARGUMENT",
    );
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

    // healthCheck() triggers strategy.connect() internally via
    // #request and throws a typed K8sAgentSandboxError on any
    // non-2xx response (carrying the HTTP status + body snippet) or
    // on a transport failure. Preserve HTTP_ERROR (remote is alive
    // but unhealthy) so callers can distinguish from the
    // "tunnel/network is down" cases; rewrap anything else as
    // SANDBOX_NOT_REACHABLE with the original as cause.
    try {
      await this.#httpClient.healthCheck();
    } catch (err) {
      if (err instanceof K8sAgentSandboxError) {
        if (err.code === "HTTP_ERROR") {
          throw new K8sAgentSandboxError(
            `Sandbox '${this.#sandboxId}' is reachable but unhealthy: ${err.message}`,
            "SANDBOX_NOT_REACHABLE",
            err,
            err.httpStatus,
          );
        }
        throw err;
      }
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
    // Lift the signal out of the try block so the catch can inspect
    // `signal.aborted` — the most reliable timeout detection across
    // Node versions, since the `err.name` fluctuated from
    // "AbortError" (Node 18) to "TimeoutError" (Node 20+).
    const signal =
      effectiveTimeout > 0
        ? AbortSignal.timeout(effectiveTimeout * 1000)
        : undefined;

    try {
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
      //
      // Prefer checking whether the per-call signal was aborted
      // (stable across Node versions) over matching `err.name`
      // (changed from "AbortError" in Node 18 to "TimeoutError" in
      // Node 20). Fall back to the name check for extra safety on
      // older runtimes.
      const isTimeout =
        (signal !== undefined && signal.aborted) ||
        (err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError"));
      if (isTimeout) {
        throw new K8sAgentSandboxError(
          `Execute timed out after ${effectiveTimeout}s: ${err instanceof Error ? err.message : String(err)}`,
          "COMMAND_TIMEOUT",
          err instanceof Error ? err : undefined,
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
    const runtimeWorkDir = this.#runtimeWorkDir;
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

      // LC_ALL=C forces locale-independent English stderr so our
      // error-mapping substring matches below work under any
      // container locale. Without this, a sandbox image running e.g.
      // `LANG=de_DE.UTF-8` emits "Keine Berechtigung" instead of
      // "permission denied" and every failure collapses to the
      // `invalid_path` fallback.
      //
      // The symlink-escape guard (`case "$(realpath ...)" in`) checks
      // that the parent directory's real path still starts with
      // `runtimeWorkDir`. `downloadFiles` goes through the
      // runtime's `/download` endpoint which enforces chroot via
      // `os.path.realpath + commonpath` — but `uploadFiles` uses
      // `sh -c` which bypasses that sanitizer. Without this guard,
      // a pre-existing symlink inside /app (created by an earlier
      // command, or left over from a prior sandbox session on a
      // shared volume) would let upload write outside the chroot.
      // We compute the parent's realpath before the write and
      // reject if it escapes runtimeWorkDir, then let `mkdir -p`
      // and `base64 -d` run normally.
      const workDirPrefix = runtimeWorkDir === "/" ? "/" : runtimeWorkDir;
      const guardedDir = dir || runtimeWorkDir;
      const mkdirPart =
        guardedDir === runtimeWorkDir
          ? ""
          : `mkdir -p ${shellQuote(guardedDir)} && `;
      const cmd =
        `LC_ALL=C sh -c ${shellQuote(
          `${mkdirPart}` +
            `real=$(realpath -m -- ${shellQuote(guardedDir)}) && ` +
            `case "$real/" in ` +
            `${shellQuote(workDirPrefix === "/" ? "/" : workDirPrefix + "/")}*) ;; ` +
            `*) echo "symlink-escape: $real not under ${workDirPrefix}" >&2; exit 77 ;; ` +
            `esac && ` +
            `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(absolutePath)}`,
        )}`;

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
      // exit 77 is our custom symlink-escape marker from the wrapper
      // above. Map it to `permission_denied` — the agent should
      // treat it as "this path is off-limits", not as a retry target.
      if (result.exitCode === 77 || stderr.includes("symlink-escape")) {
        error = "permission_denied";
      } else if (stderr.includes("permission denied") || stderr.includes("eacces")) {
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

    // First pass: build the full response array AND collect any
    // transport-level / precondition errors. These must surface to
    // the caller via a typed throw so the partial state is recoverable
    // and the typed error code is preserved. The previous version
    // threw from inside `Array.prototype.map` which aborted iteration
    // mid-way and silently dropped fulfilled responses for files
    // that DID upload successfully — the state on the server was
    // real, only the caller's record was lost.
    const responses: FileUploadResponse[] = [];
    const transportErrors: K8sAgentSandboxError[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        responses.push(s.value);
        return;
      }
      const err = s.reason;
      if (
        err instanceof K8sAgentSandboxError &&
        K8sAgentSandbox.#isBatchFatalCode(err.code)
      ) {
        transportErrors.push(err);
        // Record a per-file failure entry so the response array
        // indices match the input. Use `invalid_path` as the
        // least-misleading FileOperationError fallback — the typed
        // error thrown below carries the real cause.
        responses.push({
          path: files[i]![0],
          error: "invalid_path" as FileOperationError,
        });
        return;
      }
      // Genuinely unknown error path: log so an operator can
      // diagnose, then fall back to `invalid_path`.
      console.warn(
        `uploadFiles: unexpected error for '${files[i]![0]}': ${err instanceof Error ? err.message : String(err)}`,
      );
      responses.push({
        path: files[i]![0],
        error: "invalid_path" as FileOperationError,
      });
    });

    if (transportErrors.length > 0) {
      throw K8sAgentSandbox.#buildUploadBatchError(
        files.length,
        transportErrors,
        responses,
      );
    }

    return responses;
  }

  /**
   * Codes that abort an entire batch (transport / precondition)
   * rather than producing a per-file error response. These must be
   * surfaced via a thrown batch error subclass, not flattened into
   * the per-file `FileOperationError` enum:
   *
   * - Transport errors (`CONNECTION_FAILED`, `TUNNEL_FAILED`,
   *   `HTTP_ERROR`) abort because the network/router is broken; no
   *   point continuing the batch.
   * - `NOT_INITIALIZED` is a precondition violation that affects
   *   every file in the batch identically.
   * - `COMMAND_TIMEOUT` was set per-batch (the per-call timeout
   *   default), so all subsequent files would hit it too.
   * - `INVALID_ARGUMENT` is a security boundary (path traversal,
   *   empty path) — must be visible to the caller, NOT degraded to
   *   a per-file `invalid_path` response that an LLM could ignore.
   */
  static #isBatchFatalCode(code: string): boolean {
    return (
      code === "CONNECTION_FAILED" ||
      code === "TUNNEL_FAILED" ||
      code === "HTTP_ERROR" ||
      code === "NOT_INITIALIZED" ||
      code === "COMMAND_TIMEOUT" ||
      code === "INVALID_ARGUMENT"
    );
  }

  /**
   * Format the batch error message. Shared between upload and
   * download batch errors so the wording stays consistent.
   */
  static #formatBatchMessage(
    operation: string,
    totalFiles: number,
    transportErrors: readonly K8sAgentSandboxError[],
  ): string {
    const primary = transportErrors[0]!;
    return (
      `${operation}: ${transportErrors.length}/${totalFiles} files hit fatal errors: ${primary.message}` +
      (transportErrors.length > 1
        ? ` (and ${transportErrors.length - 1} other error(s); see .transportErrors)`
        : "")
    );
  }

  /**
   * Build a `K8sFileUploadBatchError` from collected transport errors
   * plus the per-file response array. The concrete subclass means
   * callers get fully-typed `partialResults: readonly FileUploadResponse[]`
   * on a plain `instanceof K8sFileUploadBatchError` check — no cast,
   * no generic that erases at the catch boundary.
   */
  static #buildUploadBatchError(
    totalFiles: number,
    transportErrors: K8sAgentSandboxError[],
    partialResults: FileUploadResponse[],
  ): K8sFileUploadBatchError {
    const primary = transportErrors[0]!;
    return new K8sFileUploadBatchError(
      K8sAgentSandbox.#formatBatchMessage("uploadFiles", totalFiles, transportErrors),
      primary.code,
      partialResults,
      transportErrors,
      primary,
      primary.httpStatus,
    );
  }

  /**
   * Build a `K8sFileDownloadBatchError` from collected transport
   * errors plus the per-file response array. See
   * `#buildUploadBatchError` for the typed-subclass rationale.
   */
  static #buildDownloadBatchError(
    totalFiles: number,
    transportErrors: K8sAgentSandboxError[],
    partialResults: FileDownloadResponse[],
  ): K8sFileDownloadBatchError {
    const primary = transportErrors[0]!;
    return new K8sFileDownloadBatchError(
      K8sAgentSandbox.#formatBatchMessage("downloadFiles", totalFiles, transportErrors),
      primary.code,
      partialResults,
      transportErrors,
      primary,
      primary.httpStatus,
    );
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

    // Build the full response array AND collect batch-fatal errors
    // separately. Same partial-success-preservation pattern as
    // uploadFiles — see the comment there for the rationale.
    const responses: FileDownloadResponse[] = [];
    const transportErrors: K8sAgentSandboxError[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        responses.push(s.value);
        return;
      }
      const err = s.reason;
      if (err instanceof K8sAgentSandboxError) {
        if (K8sAgentSandbox.#isBatchFatalCode(err.code)) {
          transportErrors.push(err);
          responses.push({
            path: paths[i]!,
            content: null,
            error: "file_not_found",
          });
          return;
        }
        // Per-file errors: use the typed httpStatus instead of
        // string-matching the message. The previous
        // `err.message.includes("Access denied")` check was one
        // rename away from silently degrading every 403 to
        // `file_not_found`.
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
        responses.push({ path: paths[i]!, content: null, error });
        return;
      }
      // Non-K8sAgentSandboxError rejection — preserve as a generic
      // failure entry.
      console.warn(
        `downloadFiles: unexpected error for '${paths[i]}': ${err instanceof Error ? err.message : String(err)}`,
      );
      responses.push({
        path: paths[i]!,
        content: null,
        error: "file_not_found",
      });
    });

    if (transportErrors.length > 0) {
      throw K8sAgentSandbox.#buildDownloadBatchError(
        paths.length,
        transportErrors,
        responses,
      );
    }

    return responses;
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

    // Tear down the HTTP client (and its tunnel subprocess) BEFORE
    // deleting the claim. Two reasons:
    // 1. Closing the tunnel first cleanly terminates any in-flight
    //    HTTP requests with a local CONNECTION_FAILED instead of an
    //    ECONNRESET from the controller deleting the pod under them.
    // 2. Resource ordering: we want the least-revocable resource
    //    (subprocess) torn down before the external state (claim).
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

    // Best-effort: tear down the K8sClient so any in-flight watches
    // (e.g. from a lingering resolveSandboxName) release their
    // HTTP/2 streams. Failures here are logged, not raised — close()
    // is already handling the primary cleanup and we don't want to
    // mask the real teardown error with a secondary aborted-watch
    // complaint.
    if (this.#k8sClient) {
      try {
        await this.#k8sClient.close();
      } catch (err) {
        console.warn(
          `Failed to close K8sClient: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (errors.length > 0) {
      // Single-error case: re-throw the original error directly when
      // it's already a typed K8sAgentSandboxError so the caller can
      // branch on err.code (e.g. TUNNEL_FAILED). The previous version
      // wrapped EVERYTHING as K8S_API_ERROR which threw away the
      // original code and broke caller-side error type matching.
      if (errors.length === 1) {
        const only = errors[0]!;
        if (only instanceof K8sAgentSandboxError) {
          throw only;
        }
        throw new K8sAgentSandboxError(
          `K8sAgentSandbox.close failed: ${only.message}`,
          "K8S_API_ERROR",
          only,
        );
      }
      // Multiple errors: throw an AggregateError so every individual
      // error's typed `.code`/`.httpStatus` is reachable via
      // `.errors`. When at least one is typed, also promote the
      // first typed error's code onto the AggregateError so callers
      // doing a naive `err.code` check still get something useful
      // for the common case.
      const firstTyped = errors.find(
        (e): e is K8sAgentSandboxError => e instanceof K8sAgentSandboxError,
      );
      const agg = new AggregateError(
        errors,
        `K8sAgentSandbox.close failed with ${errors.length} errors` +
          (firstTyped ? ` (primary: ${firstTyped.code})` : ""),
      ) as AggregateError & { code?: K8sAgentSandboxErrorCode };
      if (firstTyped) {
        agg.code = firstTyped.code;
      }
      throw agg;
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
    // Require initialize() first. Without this gate, `healthz()` on a
    // tunnel-mode sandbox would spawn the kubectl subprocess (via
    // strategy.connect()) as a side effect — and calling it after
    // `close()` would resurrect the tunnel, undoing the teardown.
    // The only reason `healthz()` existed without the gate previously
    // was so it could be used as a pre-init smoke test; that use is
    // a false economy because the tunnel subprocess leaks if the
    // caller then decides not to initialize.
    this.#assertRunning("healthz");
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
      runtimeWorkDir?: string;
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
      runtimeWorkDir: options?.runtimeWorkDir,
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
      routerNamespace: namespace,
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
          runtimeWorkDir: options.runtimeWorkDir,
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
      // Two-stage cleanup, both gated on `deleteOnClose`:
      //
      // 1. If a sandbox was constructed, call its `close()` to tear
      //    down the tunnel subprocess (preventing kubectl-port-forward
      //    leaks). With deleteOnClose=true, close() also attempts to
      //    delete the claim. We pass throwOnError:false because
      //    surfacing a cleanup error during a creation-failure unwind
      //    would mask the original creation error.
      //
      // 2. If `deleteOnClose` is true AND we want belt-and-braces
      //    safety (close() may have swallowed a transient delete
      //    failure inside its own try/catch), explicitly call
      //    `deleteSandboxClaim` as a fallback. This recovers from
      //    transient delete failures during close() — the cost is
      //    one 404 on the happy path, which deleteSandboxClaim
      //    silently absorbs.
      //
      // When `deleteOnClose=false` the user explicitly opted into
      // keeping the claim around (typically for debugging), so we
      // do NOT delete it on creation failure. The previous version
      // unconditionally ran the explicit delete, which violated this
      // opt-in.
      if (sandbox !== null) {
        try {
          await sandbox.close({ throwOnError: false });
        } catch (closeErr) {
          // close() with throwOnError:false should not throw, but
          // log diagnostic detail if it does. Falling through silently
          // here was a round-4 finding — we'd lose both the original
          // creation error AND the cleanup failure in the silent case.
          console.warn(
            `Cleanup close() during create() unwind failed unexpectedly: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
          );
        }
      }
      if (deleteOnClose) {
        try {
          await k8sClient.deleteSandboxClaim(claimName, namespace);
        } catch (cleanupErr) {
          // 404 is silently ignored inside deleteSandboxClaim, so
          // any exception here means the K8s API rejected a non-404
          // delete (transient unavailability, RBAC, etc.). Log
          // loudly so the operator can clean up manually before the
          // claim accrues billing or pod resources.
          console.warn(
            `Failed to clean up SandboxClaim '${claimName}' after creation failure: ` +
              `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}. ` +
              `Manual cleanup: kubectl delete sandboxclaim ${claimName} -n ${namespace}`,
          );
        }
      } else {
        // deleteOnClose=false — log the leftover claim so the user
        // knows where to find it.
        console.warn(
          `Sandbox creation failed; SandboxClaim '${claimName}' was left in namespace '${namespace}' ` +
            `because deleteOnClose=false. Manual cleanup: kubectl delete sandboxclaim ${claimName} -n ${namespace}`,
        );
      }
      // Release any in-flight k8s watches on the local k8sClient. If
      // sandbox was constructed its close() already called
      // k8sClient.close(), but for the sandbox===null path (claim
      // create / resolveSandboxName / waitForSandboxReady failure)
      // this is the only place it happens.
      if (sandbox === null) {
        try {
          await k8sClient.close();
        } catch (cleanupErr) {
          console.warn(
            `Failed to close K8sClient during create() unwind: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
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
      runtimeWorkDir?: string;
    },
  ): Promise<K8sAgentSandbox> {
    const namespace = options?.namespace ?? "default";
    const resolveTimeout = options?.resolveTimeout ?? 30;
    const connectionConfig: K8sConnectionConfig = options?.connectionConfig ?? {
      type: "tunnel",
      routerNamespace: namespace,
    };

    const k8sClient = new K8sClient();
    let sandboxId: string;
    try {
      sandboxId = await k8sClient.resolveSandboxName(
        claimName,
        namespace,
        resolveTimeout,
      );
    } catch (resolveErr) {
      // Release the k8sClient (which may have an in-flight watch)
      // before propagating. Without this, a resolveSandboxName
      // failure (claim not found, RBAC denied) leaks an HTTP/2
      // watch stream against the API server.
      try {
        await k8sClient.close();
      } catch (cleanupErr) {
        console.warn(
          `Failed to close K8sClient during fromExisting() unwind: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
      throw resolveErr;
    }

    const sandbox = new K8sAgentSandbox(
      {
        connectionConfig,
        sandboxId,
        namespace,
        defaultTimeout: options?.defaultTimeout,
        deleteOnClose: options?.deleteOnClose,
        claimName,
        rootDir: options?.rootDir,
        runtimeWorkDir: options?.runtimeWorkDir,
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
      } catch (closeErr) {
        // Log diagnostic detail rather than silently dropping the
        // secondary failure. Round-4 finding: empty catch here
        // would hide both the init error AND the close error.
        console.warn(
          `Cleanup close() during fromExisting() unwind failed unexpectedly: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
        );
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
