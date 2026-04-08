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
 * Kubernetes CRD operations for Agent Sandbox lifecycle management.
 *
 * Provides watch-based operations for SandboxClaim creation, readiness
 * polling, and deletion via the Kubernetes custom resource API.
 */

import * as k8s from "@kubernetes/client-node";
import { K8sAgentSandboxError, type K8sAgentSandboxErrorCode } from "./types.js";

// ---------------------------------------------------------------------------
// @kubernetes/client-node v1.x ApiException shape
// ---------------------------------------------------------------------------

/**
 * Extracts the HTTP status code from a `@kubernetes/client-node` v1.x
 * `ApiException`, which exposes the status on a flat `code: number`
 * field (not `response.statusCode` as in v0.x — that v0 shape was
 * silently accepted by the previous version of this file and every
 * 404-idempotency path broke as a result).
 *
 * We detect the code via duck-typing on `{ code: number }` to avoid
 * importing the class directly (the generated export lives at a
 * version-dependent path and a direct import would couple us to a
 * specific subpath layout that moves between minor releases).
 */
function getApiStatusCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

// ---------------------------------------------------------------------------
// CRD API constants
// ---------------------------------------------------------------------------

const CLAIM_API_GROUP = "extensions.agents.x-k8s.io";
const CLAIM_API_VERSION = "v1alpha1";
const CLAIM_PLURAL = "sandboxclaims";

const SANDBOX_API_GROUP = "agents.x-k8s.io";
const SANDBOX_API_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

const GATEWAY_API_GROUP = "gateway.networking.k8s.io";
const GATEWAY_API_VERSION = "v1";
const GATEWAY_PLURAL = "gateways";

// ---------------------------------------------------------------------------
// K8s watch event types
// ---------------------------------------------------------------------------

interface WatchEvent<T = Record<string, unknown>> {
  type: "ADDED" | "MODIFIED" | "DELETED" | "ERROR";
  object: T;
}

interface SandboxClaimStatus {
  // Older controllers (pre upstream PR #440) serialize this field as
  // `Name` (capital N) because the Go struct's JSON tag was explicitly
  // `json:"Name,omitempty"`. PR #440 renamed the tag to
  // `json:"name,omitempty"`, so newer controllers serialize it as
  // `name`. The Go field name stayed `Name` — only the JSON tag
  // changed. Accept both for backward compatibility, mirroring the
  // Python SDK's backcompat fix in upstream PR #515.
  sandbox?: { name?: string; Name?: string };
}

interface SandboxCondition {
  type: string;
  status: string;
}

interface SandboxStatus {
  conditions?: SandboxCondition[];
}

interface GatewayAddress {
  value?: string;
}

interface GatewayStatus {
  addresses?: GatewayAddress[];
}

// ---------------------------------------------------------------------------
// WatchUntil options
// ---------------------------------------------------------------------------

interface WatchUntilOptions<T> {
  path: string;
  fieldSelector: string;
  timeoutSeconds: number;
  timeoutError: K8sAgentSandboxError;
  deletedError?: K8sAgentSandboxError;
  streamEndedMessage: string;
  errorCode: K8sAgentSandboxErrorCode;
  extract: (event: WatchEvent) => T | undefined;
}

// ---------------------------------------------------------------------------
// Label selector validation
// ---------------------------------------------------------------------------

// Per https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#syntax-and-character-set:
//   - Label key name segment: up to 63 characters, [A-Za-z0-9] at the
//     edges, [-A-Za-z0-9_.] internally.
//   - Label key optional DNS-subdomain prefix up to 253 characters
//     followed by `/`.
//   - Label value: up to 63 characters, same character set as the key
//     name segment, or the empty string.
const LABEL_KEY_NAME_RE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_KEY_PREFIX_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/;
const LABEL_VALUE_RE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;

function validateLabelKey(key: string): void {
  if (key.length === 0 || key.length > 253) {
    throw new K8sAgentSandboxError(
      `Invalid label key ${JSON.stringify(key)}: must be 1-253 characters`,
      "INVALID_ARGUMENT",
    );
  }
  const slashIndex = key.indexOf("/");
  let prefix: string | undefined;
  let name: string;
  if (slashIndex === -1) {
    name = key;
  } else {
    prefix = key.slice(0, slashIndex);
    name = key.slice(slashIndex + 1);
    if (prefix.length === 0 || prefix.length > 253 || !LABEL_KEY_PREFIX_RE.test(prefix)) {
      throw new K8sAgentSandboxError(
        `Invalid label key ${JSON.stringify(key)}: prefix must be a valid DNS subdomain`,
        "INVALID_ARGUMENT",
      );
    }
  }
  if (name.length === 0 || name.length > 63 || !LABEL_KEY_NAME_RE.test(name)) {
    throw new K8sAgentSandboxError(
      `Invalid label key ${JSON.stringify(key)}: name segment must match ${LABEL_KEY_NAME_RE}`,
      "INVALID_ARGUMENT",
    );
  }
}

function validateLabelValue(key: string, value: string): void {
  if (value.length > 63 || !LABEL_VALUE_RE.test(value)) {
    throw new K8sAgentSandboxError(
      `Invalid label value for key ${JSON.stringify(key)}: ${JSON.stringify(value)} must match ${LABEL_VALUE_RE} (max 63 chars)`,
      "INVALID_ARGUMENT",
    );
  }
}

/**
 * Serialize a labels record into a Kubernetes `labelSelector` query
 * string, validating keys and values first. Throws
 * `K8sAgentSandboxError("INVALID_ARGUMENT", ...)` on any invalid entry
 * rather than silently producing a malformed or over-broad selector.
 */
function serializeLabelSelector(labels: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    validateLabelKey(key);
    validateLabelValue(key, value);
    parts.push(`${key}=${value}`);
  }
  return parts.join(",");
}

// ---------------------------------------------------------------------------
// K8sClient
// ---------------------------------------------------------------------------

export class K8sClient {
  #customApi: k8s.CustomObjectsApi;
  #watch: k8s.Watch;
  /**
   * All in-flight watch AbortControllers. Tracked so `close()` can
   * cancel them — without this, a `create()` that fails mid-watch
   * leaves an HTTP/2 watch stream open against the API server until
   * the Node process dies.
   */
  #activeWatches: Set<{ abort: () => void }> = new Set();
  #closed: boolean = false;

  constructor(kubeConfig?: k8s.KubeConfig) {
    const kc = kubeConfig ?? new k8s.KubeConfig();
    if (!kubeConfig) {
      // @kubernetes/client-node's `loadFromCluster()` does not throw when
      // called outside a pod — it silently returns a config whose cluster
      // server URL is `https://undefined:undefined`, which then crashes
      // at request time with an "Invalid URL" error. Detect the in-pod
      // environment explicitly via the standard KUBERNETES_SERVICE_HOST
      // env var (set by the kubelet for every pod) before choosing a
      // loader.
      if (process.env.KUBERNETES_SERVICE_HOST) {
        kc.loadFromCluster();
      } else {
        kc.loadFromDefault();
      }
    }
    this.#customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.#watch = new k8s.Watch(kc);
  }

  /**
   * Creates a SandboxClaim custom resource.
   */
  async createSandboxClaim(
    name: string,
    template: string,
    namespace: string,
    options?: { labels?: Record<string, string>; annotations?: Record<string, string> },
  ): Promise<void> {
    // Validate labels client-side for symmetry with listSandboxClaims /
    // deleteAll. Without this, a caller can create a claim with labels
    // that pass K8s's own (loose) validation but fail our stricter
    // regex — later making the same claim unreachable from the
    // list/delete paths.
    if (options?.labels) {
      for (const [key, value] of Object.entries(options.labels)) {
        validateLabelKey(key);
        validateLabelValue(key, value);
      }
    }
    const metadata: Record<string, unknown> = {
      name,
      annotations: options?.annotations ?? {},
    };
    if (options?.labels) {
      metadata.labels = options.labels;
    }

    const manifest = {
      apiVersion: `${CLAIM_API_GROUP}/${CLAIM_API_VERSION}`,
      kind: "SandboxClaim",
      metadata,
      spec: {
        sandboxTemplateRef: { name: template },
      },
    };

    try {
      await this.#customApi.createNamespacedCustomObject({
        group: CLAIM_API_GROUP,
        version: CLAIM_API_VERSION,
        namespace,
        plural: CLAIM_PLURAL,
        body: manifest,
      });
    } catch (err) {
      throw new K8sAgentSandboxError(
        `Failed to create SandboxClaim '${name}': ${err instanceof Error ? err.message : String(err)}`,
        "K8S_API_ERROR",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Watches the SandboxClaim until `status.sandbox.name` is populated,
   * then returns the resolved Sandbox name.
   */
  async resolveSandboxName(
    claimName: string,
    namespace: string,
    timeoutSeconds: number,
  ): Promise<string> {
    const path = `/apis/${CLAIM_API_GROUP}/${CLAIM_API_VERSION}/namespaces/${namespace}/${CLAIM_PLURAL}`;

    return this.#watchUntil({
      path,
      fieldSelector: `metadata.name=${claimName}`,
      timeoutSeconds,
      timeoutError: new K8sAgentSandboxError(
        `Could not resolve sandbox name from claim '${claimName}' within ${timeoutSeconds}s`,
        "SANDBOX_CREATION_FAILED",
      ),
      deletedError: new K8sAgentSandboxError(
        `SandboxClaim '${claimName}' was deleted while resolving sandbox name`,
        "SANDBOX_NOT_FOUND",
      ),
      streamEndedMessage: `Watch stream for SandboxClaim '${claimName}' ended before sandbox name was resolved`,
      errorCode: "K8S_API_ERROR",
      extract: (event) => {
        const status = (event.object as Record<string, unknown>)
          .status as SandboxClaimStatus | undefined;
        return status?.sandbox?.name || status?.sandbox?.Name || undefined;
      },
    });
  }

  /**
   * Watches the Sandbox resource until condition type=Ready status=True.
   */
  async waitForSandboxReady(
    sandboxName: string,
    namespace: string,
    timeoutSeconds: number,
  ): Promise<void> {
    const path = `/apis/${SANDBOX_API_GROUP}/${SANDBOX_API_VERSION}/namespaces/${namespace}/${SANDBOX_PLURAL}`;

    await this.#watchUntil<true>({
      path,
      fieldSelector: `metadata.name=${sandboxName}`,
      timeoutSeconds,
      timeoutError: new K8sAgentSandboxError(
        `Sandbox '${sandboxName}' did not become ready within ${timeoutSeconds}s`,
        "SANDBOX_CREATION_FAILED",
      ),
      deletedError: new K8sAgentSandboxError(
        `Sandbox '${sandboxName}' was deleted before becoming ready`,
        "SANDBOX_NOT_FOUND",
      ),
      streamEndedMessage: `Watch stream for Sandbox '${sandboxName}' ended before it became ready`,
      errorCode: "K8S_API_ERROR",
      extract: (event) => {
        const status = (event.object as Record<string, unknown>)
          .status as SandboxStatus | undefined;
        const conditions = status?.conditions ?? [];
        const ready = conditions.find(
          (c) => c.type === "Ready" && c.status === "True",
        );
        return ready ? true as const : undefined;
      },
    });
  }

  /**
   * Deletes a SandboxClaim. Silently ignores 404 (already deleted).
   */
  async deleteSandboxClaim(name: string, namespace: string): Promise<void> {
    try {
      await this.#customApi.deleteNamespacedCustomObject({
        group: CLAIM_API_GROUP,
        version: CLAIM_API_VERSION,
        namespace,
        plural: CLAIM_PLURAL,
        name,
      });
    } catch (err) {
      if (getApiStatusCode(err) !== 404) {
        throw new K8sAgentSandboxError(
          `Failed to delete SandboxClaim '${name}': ${err instanceof Error ? err.message : String(err)}`,
          "K8S_API_ERROR",
          err instanceof Error ? err : undefined,
        );
      }
    }
  }

  /**
   * Gets a Sandbox resource. Returns null if not found.
   */
  async getSandbox(
    name: string,
    namespace: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const resp = await this.#customApi.getNamespacedCustomObject({
        group: SANDBOX_API_GROUP,
        version: SANDBOX_API_VERSION,
        namespace,
        plural: SANDBOX_PLURAL,
        name,
      });
      return resp as Record<string, unknown>;
    } catch (err) {
      if (getApiStatusCode(err) === 404) return null;
      throw new K8sAgentSandboxError(
        `Failed to get Sandbox '${name}': ${err instanceof Error ? err.message : String(err)}`,
        "K8S_API_ERROR",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Lists SandboxClaim names in a namespace, optionally filtered by labels.
   *
   * When `labels` is non-empty, only claims matching ALL of the given
   * label key/value pairs are returned (translated to a Kubernetes
   * `labelSelector` of the form `k1=v1,k2=v2`). When `labels` is empty
   * or omitted, all claims in the namespace are returned.
   *
   * Keys and values are validated against Kubernetes label syntax
   * (https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#syntax-and-character-set)
   * before being serialized into the selector. This prevents a label
   * like `{owner: "alice,env=prod"}` from silently widening into a
   * two-predicate selector — the kind of footgun that would cause
   * `deleteAll` to delete more claims than the caller intended.
   */
  async listSandboxClaims(
    namespace: string,
    labels?: Record<string, string>,
  ): Promise<string[]> {
    const labelSelector =
      labels && Object.keys(labels).length > 0
        ? serializeLabelSelector(labels)
        : undefined;

    try {
      const resp = await this.#customApi.listNamespacedCustomObject({
        group: CLAIM_API_GROUP,
        version: CLAIM_API_VERSION,
        namespace,
        plural: CLAIM_PLURAL,
        ...(labelSelector !== undefined ? { labelSelector } : {}),
      });
      const body = resp as { items?: Array<{ metadata?: { name?: string } }> };
      return (body.items ?? [])
        .map((item) => item.metadata?.name)
        .filter((n): n is string => !!n);
    } catch (err) {
      throw new K8sAgentSandboxError(
        `Failed to list SandboxClaims: ${err instanceof Error ? err.message : String(err)}`,
        "K8S_API_ERROR",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Watches a Gateway resource until an external IP is assigned.
   */
  async waitForGatewayIp(
    gatewayName: string,
    namespace: string,
    timeoutSeconds: number,
  ): Promise<string> {
    const path = `/apis/${GATEWAY_API_GROUP}/${GATEWAY_API_VERSION}/namespaces/${namespace}/${GATEWAY_PLURAL}`;

    return this.#watchUntil({
      path,
      fieldSelector: `metadata.name=${gatewayName}`,
      timeoutSeconds,
      timeoutError: new K8sAgentSandboxError(
        `Gateway '${gatewayName}' did not receive an IP within ${timeoutSeconds}s`,
        "CONNECTION_FAILED",
      ),
      streamEndedMessage: `Watch stream for Gateway '${gatewayName}' ended before an IP was assigned`,
      errorCode: "CONNECTION_FAILED",
      extract: (event) => {
        const status = (event.object as Record<string, unknown>)
          .status as GatewayStatus | undefined;
        return status?.addresses?.[0]?.value || undefined;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Private watch helper
  // -------------------------------------------------------------------------

  /**
   * Close the K8sClient and abort any in-flight watches.
   *
   * Safe to call multiple times. After close(), `#watchUntil` rejects
   * immediately rather than starting a new watch — this prevents a
   * caller from resurrecting torn-down state by calling
   * `resolveSandboxName` post-close.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const req of this.#activeWatches) {
      try {
        req.abort();
      } catch {
        // Best-effort: some abort implementations throw if the
        // underlying stream has already ended. Individual abort
        // failures must not prevent subsequent aborts from running.
      }
    }
    this.#activeWatches.clear();
  }

  /**
   * Generic watch-until-condition helper that handles timeout, abort,
   * deletion, and stream-end scenarios in one place.
   */
  async #watchUntil<T>(opts: WatchUntilOptions<T>): Promise<T> {
    if (this.#closed) {
      throw new K8sAgentSandboxError(
        "K8sClient is closed",
        "K8S_API_ERROR",
      );
    }
    return new Promise<T>((resolve, reject) => {
      let watchReq: { abort: () => void } | undefined;
      let settled = false;

      const settle = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (watchReq) {
            this.#activeWatches.delete(watchReq);
            watchReq.abort();
          }
        }
      };

      const timer = setTimeout(() => {
        settle();
        reject(opts.timeoutError);
      }, opts.timeoutSeconds * 1000);

      this.#watch
        .watch(
          opts.path,
          { fieldSelector: opts.fieldSelector },
          (phase: string, obj: Record<string, unknown>) => {
            if (settled) return;
            const event = { type: phase, object: obj } as WatchEvent;

            if (event.type === "DELETED" && opts.deletedError) {
              settle();
              reject(opts.deletedError);
              return;
            }

            if (event.type === "ADDED" || event.type === "MODIFIED") {
              const value = opts.extract(event);
              if (value !== undefined) {
                settle();
                resolve(value);
              }
            }
          },
          (err) => {
            if (settled) return;
            settle();
            reject(
              new K8sAgentSandboxError(
                err
                  ? `Watch error: ${err instanceof Error ? err.message : String(err)}`
                  : opts.streamEndedMessage,
                opts.errorCode,
                err instanceof Error ? err : undefined,
              ),
            );
          },
        )
        .then((req) => {
          // If the event callback already settled the promise (common
          // when the resource already matched at watch-start time),
          // abort the controller immediately — otherwise it leaks an
          // HTTP/2 watch stream against the API server until the Node
          // process exits. The previous version assigned to `watchReq`
          // unconditionally and relied on the already-elapsed
          // `settle()` having captured the (still-undefined)
          // controller, orphaning it forever.
          if (settled) {
            try {
              req.abort();
            } catch {
              // abort() may throw if the stream already ended; safe
              // to ignore because we're discarding the controller.
            }
            return;
          }
          watchReq = req;
          this.#activeWatches.add(req);
        })
        .catch((err) => {
          if (settled) return;
          settle();
          reject(
            new K8sAgentSandboxError(
              `Failed to start watch: ${err instanceof Error ? err.message : String(err)}`,
              opts.errorCode,
              err instanceof Error ? err : undefined,
            ),
          );
        });
    });
  }
}
