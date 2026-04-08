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

import { type SandboxErrorCode, SandboxError } from "deepagents";

// ---------------------------------------------------------------------------
// Connection configuration (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Connect directly to a sandbox-router at a known URL.
 *
 * Use this when you already have network access to the sandbox-router
 * service (e.g. via an ingress, load balancer, or local port-forward
 * you manage yourself).
 */
export interface K8sDirectConnectionConfig {
  type: "direct";
  /** Base URL of the sandbox-router, e.g. "http://localhost:8080". */
  baseUrl: string;
  /** Port the sandbox runtime listens on inside the pod. @default 8888 */
  serverPort?: number;
}

/**
 * Discover the sandbox-router URL from a Kubernetes Gateway resource.
 *
 * The provider watches the Gateway until an external IP is assigned,
 * then uses that IP as the base URL.
 */
export interface K8sGatewayConnectionConfig {
  type: "gateway";
  /** Name of the Gateway resource. */
  gatewayName: string;
  /** Namespace of the Gateway resource. @default "default" */
  gatewayNamespace?: string;
  /** Seconds to wait for the Gateway to receive an IP. @default 180 */
  gatewayReadyTimeout?: number;
  /** Port the sandbox runtime listens on inside the pod. @default 8888 */
  serverPort?: number;
}

/**
 * Use `kubectl port-forward` to tunnel traffic to the sandbox-router
 * service inside the cluster.
 *
 * Best for local development against a remote or kind cluster.
 */
export interface K8sTunnelConnectionConfig {
  type: "tunnel";
  /** Kubernetes namespace where the sandbox-router-svc lives. @default "default" */
  namespace?: string;
  /** Seconds to wait for the port-forward to become ready. @default 30 */
  portForwardReadyTimeout?: number;
  /** Port the sandbox runtime listens on inside the pod. @default 8888 */
  serverPort?: number;
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
   * Virtual root directory for file operations.
   *
   * Both `uploadFiles` and `downloadFiles` virtualize paths against
   * this root. A request for `/etc/foo` is rewritten to
   * `<rootDir>/etc/foo` before being sent to the sandbox runtime, so
   * the upload/download round-trip always lands in the same place.
   *
   * The default `/app` matches the working directory of the
   * `python-runtime-sandbox` example image and the convention used
   * across the project's example SandboxTemplates.
   *
   * @default "/app"
   */
  rootDir?: string;
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
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Error codes specific to the k8s-agent-sandbox provider.
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
 * - `COMMAND_TIMEOUT` — execute() exceeded its timeout budget
 * - `NOT_INITIALIZED` — operation called before initialize() (or after close())
 * - `FILE_OPERATION_FAILED` — file upload/download failed for an
 *   identifiable reason (permission, missing parent, etc.)
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
  | "SANDBOX_NOT_FOUND"
  | "COMMAND_TIMEOUT"
  | "NOT_INITIALIZED"
  | "FILE_OPERATION_FAILED";

const K8S_SANDBOX_ERROR_SYMBOL = Symbol.for("k8s.agent.sandbox.error");

/**
 * Custom error class for k8s-agent-sandbox operations.
 *
 * The optional `httpStatus` field carries the underlying HTTP status code
 * for transport-level errors so callers can branch on the status without
 * string-matching the message (e.g. distinguish 403 from 404 in
 * downloadFiles error mapping).
 */
export class K8sAgentSandboxError extends SandboxError {
  [K8S_SANDBOX_ERROR_SYMBOL] = true as const;

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

  static isInstance(error: unknown): error is K8sAgentSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[K8S_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}

// ---------------------------------------------------------------------------
// Health check result
// ---------------------------------------------------------------------------

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
      reason: "unreachable" | "http-error" | "timeout" | "unknown";
      error: K8sAgentSandboxError;
    };
