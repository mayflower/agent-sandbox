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
 * Type definitions for the Kubernetes Agent Sandbox backend.
 *
 * This module contains all type definitions for the langchain-agent-sandbox
 * package, including connection configuration, sandbox options, and error types.
 */

import type {
  FileDownloadResponse,
  FileUploadResponse,
  SandboxErrorCode,
} from "deepagents";
import { SandboxError } from "deepagents";

// ---------------------------------------------------------------------------
// Connection configuration (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Fields common to every connection config. Extracted from the three
 * discriminants below so `serverPort` isn't declared three times with
 * drift risk between the copies.
 */
interface K8sConnectionConfigBase {
  /** Port the sandbox runtime listens on inside the pod. @default 8888 */
  serverPort?: number;
}

/**
 * Connect directly to a sandbox-router at a known URL.
 *
 * Use this when you already have network access to the sandbox-router
 * service (e.g. via an ingress, load balancer, or local port-forward
 * you manage yourself).
 */
export interface K8sDirectConnectionConfig extends K8sConnectionConfigBase {
  type: "direct";
  /** Base URL of the sandbox-router, e.g. "http://localhost:8080". */
  baseUrl: string;
}

/**
 * Discover the sandbox-router URL from a Kubernetes Gateway resource.
 *
 * The provider watches the Gateway until an external IP is assigned,
 * then uses that IP as the base URL.
 */
export interface K8sGatewayConnectionConfig extends K8sConnectionConfigBase {
  type: "gateway";
  /** Name of the Gateway resource. */
  gatewayName: string;
  /** Namespace of the Gateway resource. @default "default" */
  gatewayNamespace?: string;
  /** Seconds to wait for the Gateway to receive an IP. @default 180 */
  gatewayReadyTimeout?: number;
}

/**
 * Use `kubectl port-forward` to tunnel traffic to the sandbox-router
 * service inside the cluster.
 *
 * Best for local development against a remote or kind cluster.
 */
export interface K8sTunnelConnectionConfig extends K8sConnectionConfigBase {
  type: "tunnel";
  /**
   * Kubernetes namespace where the `sandbox-router-svc` Service
   * lives. Distinct from the sandbox's own namespace
   * (`K8sAgentSandboxOptions.namespace`) — the router and the
   * sandbox can live in different namespaces.
   *
   * @default "default"
   */
  routerNamespace?: string;
  /**
   * Deprecated alias for `routerNamespace`. Accepted for backward
   * compatibility; prefer `routerNamespace`. If both are supplied,
   * `routerNamespace` wins.
   *
   * @deprecated Use `routerNamespace` instead.
   */
  namespace?: string;
  /** Seconds to wait for the port-forward to become ready. @default 30 */
  portForwardReadyTimeout?: number;
}

/**
 * Union of all supported connection strategies.
 */
export type K8sConnectionConfig =
  | K8sDirectConnectionConfig
  | K8sGatewayConnectionConfig
  | K8sTunnelConnectionConfig;

// ---------------------------------------------------------------------------
// Sandbox options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a {@link K8sAgentSandbox} that connects to an
 * already-existing sandbox.
 */
export interface K8sAgentSandboxOptions {
  /** How to reach the sandbox-router. */
  connectionConfig: K8sConnectionConfig;
  /** The Sandbox resource name (not the claim name). */
  sandboxId: string;
  /** Kubernetes namespace of the sandbox. @default "default" */
  namespace?: string;
  /** Default command timeout in seconds. @default 300 */
  defaultTimeout?: number;
  /** Delete the SandboxClaim when {@link K8sAgentSandbox.close} is called. @default false */
  deleteOnClose?: boolean;
  /** The SandboxClaim name, if the sandbox was provisioned via a claim. */
  claimName?: string;
  /**
   * Virtual root directory for file operations, as exposed to the LLM.
   *
   * Both `uploadFiles` and `downloadFiles` virtualize paths against
   * this root. A request for `/etc/foo` is rewritten to
   * `<rootDir>/etc/foo` before being sent to the sandbox runtime, so
   * the upload/download round-trip always lands in the same place.
   *
   * `rootDir` MUST be equal to or a subdirectory of `runtimeWorkDir`
   * (the runtime image's actual working directory). The constructor
   * rejects mis-aligned configurations with `INVALID_ARGUMENT` because
   * the sandbox runtime image hard-pins its own filesystem chroot to
   * `runtimeWorkDir` and refuses to serve files outside it.
   *
   * @default "/app"
   */
  rootDir?: string;
  /**
   * The runtime image's actual working directory inside the sandbox
   * pod. The sandbox-router endpoint resolves all file paths relative
   * to this directory and refuses to serve anything outside it.
   *
   * Override this only if you've built a custom runtime image whose
   * working directory differs from the standard `python-runtime-sandbox`.
   * `rootDir` (the LLM-facing virtual root) must equal or be a
   * subdirectory of this path.
   *
   * @default "/app"
   */
  runtimeWorkDir?: string;
}

/**
 * Options for {@link K8sAgentSandbox.create}, which provisions a new
 * sandbox via the Kubernetes API.
 */
export interface K8sAgentSandboxCreateOptions {
  /** SandboxTemplate name to create the claim from. */
  template: string;
  /** Kubernetes namespace. @default "default" */
  namespace?: string;
  /** Connection strategy. @default tunnel with default settings */
  connectionConfig?: K8sConnectionConfig;
  /** Seconds to wait for the sandbox to become ready. @default 180 */
  sandboxReadyTimeout?: number;
  /** Default command timeout in seconds. @default 300 */
  defaultTimeout?: number;
  /** Delete the SandboxClaim when close() is called. @default true */
  deleteOnClose?: boolean;
  /** Kubernetes labels to attach to the SandboxClaim. */
  labels?: Record<string, string>;
  /**
   * Files to seed into the sandbox immediately after it becomes ready.
   *
   * Keys are paths (relative to the sandbox's working directory, which
   * is `/app` by default for the python-runtime image) and values are
   * either `string` content or a raw `Uint8Array`. Parent directories
   * are created automatically. If any file fails to upload, the
   * creation is aborted and the claim is deleted.
   *
   * This matches the shape expected by the deepagents-js shared sandbox
   * standard test suite and by most deepagents-js examples.
   */
  initialFiles?: Record<string, string | Uint8Array>;
  /** Virtual root directory for file operations. @default "/app" */
  rootDir?: string;
  /** Runtime image's working directory. @default "/app" */
  runtimeWorkDir?: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Error codes specific to the k8s-agent-sandbox provider.
 *
 * Codes NOT listed here (`NOT_INITIALIZED`, `COMMAND_TIMEOUT`,
 * `FILE_OPERATION_FAILED`, `ALREADY_INITIALIZED`, `COMMAND_FAILED`)
 * come from the upstream `SandboxErrorCode` union and are carried
 * transitively.
 *
 * - `CONNECTION_FAILED` — generic transport-level connection failure
 * - `TUNNEL_FAILED` — `kubectl port-forward` subprocess failure (distinct
 *   from CONNECTION_FAILED because the remediation is different: check
 *   PATH for kubectl, check kubeconfig context, check cluster reachability)
 * - `SANDBOX_NOT_REACHABLE` — sandbox provisioned but health check fails
 * - `HTTP_ERROR` — non-2xx response from sandbox-router
 * - `K8S_API_ERROR` — Kubernetes API call failure
 * - `INVALID_ARGUMENT` — caller passed invalid parameters (precondition
 *   violation, distinct from K8S_API_ERROR which is a server-side failure)
 * - `SANDBOX_CREATION_FAILED` — creation flow failed mid-way
 * - `SANDBOX_NOT_FOUND` — referenced sandbox doesn't exist
 */
export type K8sAgentSandboxErrorCode =
  | SandboxErrorCode
  | "CONNECTION_FAILED"
  | "TUNNEL_FAILED"
  | "SANDBOX_NOT_REACHABLE"
  | "HTTP_ERROR"
  | "K8S_API_ERROR"
  | "INVALID_ARGUMENT"
  | "SANDBOX_CREATION_FAILED"
  | "SANDBOX_NOT_FOUND";

/**
 * Custom error class for k8s-agent-sandbox operations.
 *
 * The optional `httpStatus` field carries the underlying HTTP status code
 * for transport-level errors so callers can branch on the status without
 * string-matching the message (e.g. distinguish 403 from 404 in
 * downloadFiles error mapping).
 */
export class K8sAgentSandboxError extends SandboxError {
  override readonly name = "K8sAgentSandboxError";

  constructor(
    message: string,
    public readonly code: K8sAgentSandboxErrorCode,
    public override readonly cause?: Error,
    public readonly httpStatus?: number,
  ) {
    super(message, code as SandboxErrorCode, cause);
    Object.setPrototypeOf(this, K8sAgentSandboxError.prototype);
  }
}

/**
 * Shared base for batch file operation errors.
 *
 * The previous single-generic `K8sBatchOperationError<T>` design had a
 * fatal ergonomics flaw: TypeScript generics don't survive `try/catch`
 * boundaries, so every caller had to write `catch (e) { if (e
 * instanceof K8sBatchOperationError) { (e as K8sBatchOperationError<Foo>)
 * ... } }` — the exact side-channel cast the subclass was meant to
 * eliminate. Splitting into two concrete subclasses
 * (`K8sFileUploadBatchError` / `K8sFileDownloadBatchError`) lets each
 * catch site use a plain `instanceof` check AND get fully-typed
 * `partialResults` without any cast.
 */
abstract class K8sBatchOperationErrorBase extends K8sAgentSandboxError {
  constructor(
    message: string,
    code: K8sAgentSandboxErrorCode,
    /**
     * All transport errors collected from the batch. The base class's
     * `cause` only holds the first one; this list preserves every
     * error's `code`/`httpStatus`/etc. so callers don't lose sibling
     * failure modes when multiple files fail with different codes.
     */
    public readonly transportErrors: readonly K8sAgentSandboxError[],
    cause?: Error,
    httpStatus?: number,
  ) {
    super(message, code, cause, httpStatus);
  }
}

/**
 * Batch error thrown by {@link K8sAgentSandbox.uploadFiles} when one or
 * more files hit a batch-fatal error (transport failure, precondition
 * violation, etc.). Carries the full per-file response array so the
 * caller can recover entries that DID succeed.
 *
 * @example
 * ```ts
 * try {
 *   await sandbox.uploadFiles(files);
 * } catch (err) {
 *   if (err instanceof K8sFileUploadBatchError) {
 *     // partialResults is typed as readonly FileUploadResponse[]
 *     for (const r of err.partialResults) { ... }
 *   }
 * }
 * ```
 */
export class K8sFileUploadBatchError extends K8sBatchOperationErrorBase {
  // `name` is intentionally inherited from the base class —
  // K8sAgentSandboxError pins `name` to a narrow string-literal type
  // that TS won't let a subclass widen. Distinguish subclasses via
  // `instanceof` rather than `err.name` at runtime.

  constructor(
    message: string,
    code: K8sAgentSandboxErrorCode,
    public readonly partialResults: readonly FileUploadResponse[],
    transportErrors: readonly K8sAgentSandboxError[],
    cause?: Error,
    httpStatus?: number,
  ) {
    super(message, code, transportErrors, cause, httpStatus);
    Object.setPrototypeOf(this, K8sFileUploadBatchError.prototype);
  }
}

/**
 * Batch error thrown by {@link K8sAgentSandbox.downloadFiles} when one
 * or more files hit a batch-fatal error. Carries the full per-file
 * response array so the caller can recover entries that DID succeed
 * (each has a non-null `content` field).
 *
 * @example
 * ```ts
 * try {
 *   await sandbox.downloadFiles(paths);
 * } catch (err) {
 *   if (err instanceof K8sFileDownloadBatchError) {
 *     // partialResults is typed as readonly FileDownloadResponse[]
 *     const recovered = err.partialResults.filter((r) => r.content !== null);
 *   }
 * }
 * ```
 */
export class K8sFileDownloadBatchError extends K8sBatchOperationErrorBase {
  // `name` is intentionally inherited from the base class — see
  // K8sFileUploadBatchError for the rationale.

  constructor(
    message: string,
    code: K8sAgentSandboxErrorCode,
    public readonly partialResults: readonly FileDownloadResponse[],
    transportErrors: readonly K8sAgentSandboxError[],
    cause?: Error,
    httpStatus?: number,
  ) {
    super(message, code, transportErrors, cause, httpStatus);
    Object.setPrototypeOf(this, K8sFileDownloadBatchError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Health check result
// ---------------------------------------------------------------------------

/**
 * Failure category for {@link HealthzResult}. Explicit list (not a
 * fallback `"unknown"`) so `http-client.ts` can use an exhaustive
 * `switch` — adding a new category forces every call site to update.
 */
export type HealthzFailureReason =
  | "unreachable"
  | "http-error"
  | "timeout"
  | "unknown";

/**
 * Discriminated union returned by {@link K8sAgentSandbox.healthz}.
 *
 * The previous bare `boolean` form collapsed three different failure
 * modes into a single `false`, so callers couldn't distinguish "sandbox
 * is genuinely unhealthy" from "we couldn't ask the question". This shape
 * preserves the reason category and the underlying error.
 */
export type HealthzResult =
  | { ok: true }
  | {
      ok: false;
      reason: HealthzFailureReason;
      error: K8sAgentSandboxError;
    };
