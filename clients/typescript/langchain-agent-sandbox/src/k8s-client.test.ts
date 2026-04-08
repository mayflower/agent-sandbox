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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { K8sClient } from "./k8s-client.js";
import { K8sAgentSandboxError } from "./types.js";

// ---------------------------------------------------------------------------
// Mock @kubernetes/client-node
// ---------------------------------------------------------------------------

const mockCreateNamespacedCustomObject = vi.fn();
const mockDeleteNamespacedCustomObject = vi.fn();
const mockGetNamespacedCustomObject = vi.fn();
const mockListNamespacedCustomObject = vi.fn();

// Spies for the KubeConfig loader methods so tests can verify which
// branch of the constructor's in-cluster-vs-kubeconfig detection ran.
const mockLoadFromCluster = vi.fn();
const mockLoadFromDefault = vi.fn();

let watchCallback: ((phase: string, obj: Record<string, unknown>) => void) | null = null;
const mockWatchFn = vi.fn();

vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    loadFromCluster() {
      mockLoadFromCluster();
    }
    loadFromDefault() {
      mockLoadFromDefault();
    }
    makeApiClient() {
      return {
        createNamespacedCustomObject: mockCreateNamespacedCustomObject,
        deleteNamespacedCustomObject: mockDeleteNamespacedCustomObject,
        getNamespacedCustomObject: mockGetNamespacedCustomObject,
        listNamespacedCustomObject: mockListNamespacedCustomObject,
      };
    }
  }

  class MockWatch {
    constructor(_kc: unknown) {}

    watch(
      _path: string,
      _queryParams: unknown,
      callback: (phase: string, obj: Record<string, unknown>) => void,
      done: (err?: unknown) => void,
    ) {
      watchCallback = callback;
      return mockWatchFn(_path, _queryParams, callback, done);
    }
  }

  return {
    KubeConfig: MockKubeConfig,
    CustomObjectsApi: class {},
    Watch: MockWatch,
  };
});

describe("K8sClient", () => {
  let client: K8sClient;

  beforeEach(() => {
    vi.clearAllMocks();
    watchCallback = null;
    // Default: watch returns a resolved promise (the request object)
    mockWatchFn.mockResolvedValue({ abort: vi.fn() });
    client = new K8sClient();
  });

  describe("constructor (kubeconfig loader selection)", () => {
    // These tests verify the KUBERNETES_SERVICE_HOST branch: the
    // constructor should only use loadFromCluster() when the standard
    // kubelet-set pod env var is present. Outside a pod, it must use
    // loadFromDefault() — previously a naive try { loadFromCluster() }
    // catch silently succeeded with a https://undefined:undefined
    // config and crashed at request time.
    const originalEnv = process.env.KUBERNETES_SERVICE_HOST;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.KUBERNETES_SERVICE_HOST;
      } else {
        process.env.KUBERNETES_SERVICE_HOST = originalEnv;
      }
    });

    it("should call loadFromDefault when KUBERNETES_SERVICE_HOST is unset", () => {
      delete process.env.KUBERNETES_SERVICE_HOST;
      mockLoadFromCluster.mockClear();
      mockLoadFromDefault.mockClear();

      new K8sClient();

      expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
      expect(mockLoadFromCluster).not.toHaveBeenCalled();
    });

    it("should call loadFromCluster when KUBERNETES_SERVICE_HOST is set", () => {
      process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
      mockLoadFromCluster.mockClear();
      mockLoadFromDefault.mockClear();

      new K8sClient();

      expect(mockLoadFromCluster).toHaveBeenCalledTimes(1);
      expect(mockLoadFromDefault).not.toHaveBeenCalled();
    });

    it("should not call either loader when given an explicit KubeConfig", () => {
      mockLoadFromCluster.mockClear();
      mockLoadFromDefault.mockClear();

      // Passing an explicit config should bypass loader selection entirely.
      new K8sClient(new k8s.KubeConfig());

      expect(mockLoadFromCluster).not.toHaveBeenCalled();
      expect(mockLoadFromDefault).not.toHaveBeenCalled();
    });
  });

  describe("createSandboxClaim", () => {
    it("should create a SandboxClaim with correct manifest", async () => {
      mockCreateNamespacedCustomObject.mockResolvedValue({});

      await client.createSandboxClaim("test-claim", "my-template", "default", {
        labels: { app: "test" },
      });

      expect(mockCreateNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: "extensions.agents.x-k8s.io",
          version: "v1alpha1",
          namespace: "default",
          plural: "sandboxclaims",
          body: expect.objectContaining({
            kind: "SandboxClaim",
            metadata: expect.objectContaining({
              name: "test-claim",
              labels: { app: "test" },
            }),
            spec: { sandboxTemplateRef: { name: "my-template" } },
          }),
        }),
      );
    });

    it("should throw K8sAgentSandboxError on API failure", async () => {
      mockCreateNamespacedCustomObject.mockRejectedValue(
        new Error("forbidden"),
      );

      await expect(
        client.createSandboxClaim("test-claim", "tmpl", "default"),
      ).rejects.toThrow(K8sAgentSandboxError);
    });
  });

  describe("resolveSandboxName", () => {
    it("should resolve sandbox name from claim status", async () => {
      const promise = client.resolveSandboxName("claim-1", "default", 30);

      // Simulate watch event with sandbox name in status
      watchCallback?.("ADDED", {
        status: { sandbox: { name: "sandbox-abc123" } },
      });

      await expect(promise).resolves.toBe("sandbox-abc123");
    });

    it("should resolve sandbox name from the legacy capital-N Name field", async () => {
      // Pre upstream PR #440, the CRD's JSON tag was
      // `json:"Name,omitempty"`, so older controllers still in the
      // wild serialize the field as `Name`. The dual-field extract
      // in resolveSandboxName must accept both casings.
      const promise = client.resolveSandboxName("claim-1", "default", 30);

      watchCallback?.("ADDED", {
        status: { sandbox: { Name: "sandbox-legacy-xyz" } },
      });

      await expect(promise).resolves.toBe("sandbox-legacy-xyz");
    });

    it("should prefer lowercase name when both fields are present", async () => {
      // Shouldn't happen in practice but if a controller ever
      // serializes both, the new canonical field must win.
      const promise = client.resolveSandboxName("claim-1", "default", 30);

      watchCallback?.("ADDED", {
        status: {
          sandbox: { name: "sandbox-new", Name: "sandbox-old" },
        },
      });

      await expect(promise).resolves.toBe("sandbox-new");
    });

    it("should reject if claim is deleted", async () => {
      const promise = client.resolveSandboxName("claim-1", "default", 30);

      watchCallback?.("DELETED", {});

      await expect(promise).rejects.toThrow("was deleted");
    });

    it("should reject on timeout", async () => {
      vi.useFakeTimers();

      const promise = client.resolveSandboxName("claim-1", "default", 1);

      vi.advanceTimersByTime(1500);

      await expect(promise).rejects.toThrow("within 1s");

      vi.useRealTimers();
    });
  });

  describe("waitForSandboxReady", () => {
    it("should resolve when Ready condition is True", async () => {
      const promise = client.waitForSandboxReady("sb-1", "default", 30);

      watchCallback?.("MODIFIED", {
        status: {
          conditions: [{ type: "Ready", status: "True" }],
        },
      });

      await expect(promise).resolves.toBeUndefined();
    });

    it("should not resolve on non-ready conditions", async () => {
      vi.useFakeTimers();

      const promise = client.waitForSandboxReady("sb-1", "default", 1);

      watchCallback?.("MODIFIED", {
        status: {
          conditions: [{ type: "Ready", status: "False" }],
        },
      });

      vi.advanceTimersByTime(1500);

      await expect(promise).rejects.toThrow("did not become ready");

      vi.useRealTimers();
    });

    it("should reject if sandbox is deleted", async () => {
      const promise = client.waitForSandboxReady("sb-1", "default", 30);

      watchCallback?.("DELETED", {});

      await expect(promise).rejects.toThrow("was deleted");
    });
  });

  describe("deleteSandboxClaim", () => {
    it("should delete a SandboxClaim", async () => {
      mockDeleteNamespacedCustomObject.mockResolvedValue({});

      await client.deleteSandboxClaim("claim-1", "default");

      expect(mockDeleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "claim-1",
          namespace: "default",
        }),
      );
    });

    it("should silently ignore 404", async () => {
      // @kubernetes/client-node v1.x throws `ApiException` with a
      // flat `code: number` field (not `response.statusCode` as in
      // v0.x). The previous mock shape matched v0 and the
      // production code was checking v0's nested field, so every
      // 404-idempotency path was quietly broken. Mock the real
      // shape here.
      mockDeleteNamespacedCustomObject.mockRejectedValue(
        Object.assign(new Error("Not Found"), { code: 404 }),
      );

      await expect(
        client.deleteSandboxClaim("gone", "default"),
      ).resolves.toBeUndefined();
    });

    it("should throw on other errors", async () => {
      mockDeleteNamespacedCustomObject.mockRejectedValue(
        new Error("server error"),
      );

      await expect(
        client.deleteSandboxClaim("claim-1", "default"),
      ).rejects.toThrow(K8sAgentSandboxError);
    });
  });

  describe("getSandbox", () => {
    it("should return sandbox object", async () => {
      const sandbox = { metadata: { name: "sb-1" } };
      mockGetNamespacedCustomObject.mockResolvedValue(sandbox);

      const result = await client.getSandbox("sb-1", "default");
      expect(result).toEqual(sandbox);
    });

    it("should return null for 404", async () => {
      mockGetNamespacedCustomObject.mockRejectedValue(
        Object.assign(new Error("Not Found"), { code: 404 }),
      );

      const result = await client.getSandbox("gone", "default");
      expect(result).toBeNull();
    });

    it("should throw on non-404 errors (wraps as K8S_API_ERROR)", async () => {
      // Make sure the v1.x shape detection doesn't silently swallow
      // non-404 errors with a `code` field.
      mockGetNamespacedCustomObject.mockRejectedValue(
        Object.assign(new Error("Forbidden"), { code: 403 }),
      );
      await expect(
        client.getSandbox("protected", "default"),
      ).rejects.toMatchObject({ code: "K8S_API_ERROR" });
    });
  });

  describe("listSandboxClaims", () => {
    it("should return claim names", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({
        items: [
          { metadata: { name: "claim-a" } },
          { metadata: { name: "claim-b" } },
        ],
      });

      const result = await client.listSandboxClaims("default");
      expect(result).toEqual(["claim-a", "claim-b"]);
    });

    it("should handle empty list", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      const result = await client.listSandboxClaims("default");
      expect(result).toEqual([]);
    });

    it("should not pass a labelSelector when labels are omitted", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await client.listSandboxClaims("default");

      const args = mockListNamespacedCustomObject.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect("labelSelector" in args).toBe(false);
    });

    it("should not pass a labelSelector when labels object is empty", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await client.listSandboxClaims("default", {});

      const args = mockListNamespacedCustomObject.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect("labelSelector" in args).toBe(false);
    });

    it("should translate labels to a comma-joined labelSelector", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await client.listSandboxClaims("default", {
        purpose: "integration-test",
        package: "langchain-agent-sandbox",
      });

      const args = mockListNamespacedCustomObject.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(args.labelSelector).toBe(
        "purpose=integration-test,package=langchain-agent-sandbox",
      );
    });

    it("should reject label values containing a comma", async () => {
      // The footgun this validation exists to prevent: a value like
      // `"alice,env=prod"` would silently turn into a two-predicate
      // selector `owner=alice,env=prod`, widening the result set (and
      // the delete set for deleteAll).
      await expect(
        client.listSandboxClaims("default", { owner: "alice,env=prod" }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("Invalid label value"),
      });
    });

    it("should reject label values containing an equals sign", async () => {
      await expect(
        client.listSandboxClaims("default", { tier: "a=b" }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("Invalid label value"),
      });
    });

    it("should reject label values longer than 63 characters", async () => {
      await expect(
        client.listSandboxClaims("default", { big: "x".repeat(64) }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it("should accept the empty-string label value", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await client.listSandboxClaims("default", { empty: "" });

      const args = mockListNamespacedCustomObject.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(args.labelSelector).toBe("empty=");
    });

    it("should accept a DNS-subdomain prefixed key", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await client.listSandboxClaims("default", {
        "example.com/purpose": "test",
      });

      const args = mockListNamespacedCustomObject.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(args.labelSelector).toBe("example.com/purpose=test");
    });

    it("should reject a label key with a leading hyphen", async () => {
      await expect(
        client.listSandboxClaims("default", { "-badkey": "x" }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("Invalid label key"),
      });
    });
  });

  describe("waitForGatewayIp", () => {
    it("should resolve with gateway IP", async () => {
      const promise = client.waitForGatewayIp("gw-1", "default", 30);

      watchCallback?.("MODIFIED", {
        status: { addresses: [{ value: "34.56.78.90" }] },
      });

      await expect(promise).resolves.toBe("34.56.78.90");
    });

    it("should reject on timeout", async () => {
      vi.useFakeTimers();

      const promise = client.waitForGatewayIp("gw-1", "default", 1);

      vi.advanceTimersByTime(1500);

      await expect(promise).rejects.toThrow("did not receive an IP");

      vi.useRealTimers();
    });
  });
});
