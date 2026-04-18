import * as k8s from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";

import {
  KubernetesClusterReader,
  KubernetesInventoryProvider,
  resolveKubeConfigMode,
  type ClusterReader,
} from "../providers/kubernetes-provider.js";

describe("kubernetes inventory provider", () => {
  it("prefers kubeconfig unless in-cluster signals are present", () => {
    expect(resolveKubeConfigMode({ KUBECONFIG: "/tmp/config" } as NodeJS.ProcessEnv)).toBe("kubeconfig");
    expect(resolveKubeConfigMode({} as NodeJS.ProcessEnv, () => false)).toBe("kubeconfig");
    expect(
      resolveKubeConfigMode(
        { KUBERNETES_SERVICE_HOST: "10.0.0.1" } as NodeJS.ProcessEnv,
        () => true,
      ),
    ).toBe("incluster");
  });

  it("keeps core snapshot working when extension resources are unsupported", async () => {
    const reader: ClusterReader = {
      async listSandboxes() {
        return [];
      },
      async listPods() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listPersistentVolumeClaims() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async listClaims() {
        return { supported: false, items: [] };
      },
      async listWarmPools() {
        return { supported: false, items: [] };
      },
      async listTemplates() {
        return { supported: false, items: [] };
      },
      async readControllerHealth() {
        return null;
      },
      async deleteSandbox() {},
      async deleteClaim() {},
      async patchSandboxAnnotations() {},
    };

    const provider = new KubernetesInventoryProvider(reader, { cacheTtlMs: 0 });
    const snapshot = await provider.getSnapshot();

    expect(snapshot.capabilities.claims).toBe(false);
    expect(snapshot.capabilities.warmPools).toBe(false);
    expect(snapshot.capabilities.templates).toBe(false);
    expect(snapshot.sandboxes).toEqual([]);
  });

  it("marks extension capabilities supported when extension resources exist", async () => {
    const reader: ClusterReader = {
      async listSandboxes() {
        return [];
      },
      async listPods() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listPersistentVolumeClaims() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async listClaims() {
        return { supported: true, items: [{ metadata: { name: "claim", namespace: "demo" }, spec: { sandboxTemplateRef: { name: "template" } } }] };
      },
      async listWarmPools() {
        return {
          supported: true,
          items: [{ metadata: { name: "pool", namespace: "demo" }, spec: { replicas: 1, sandboxTemplateRef: { name: "template" } } }],
        };
      },
      async listTemplates() {
        return {
          supported: true,
          items: [
            {
              metadata: { name: "template", namespace: "demo" },
              spec: { podTemplate: { spec: { containers: [{ name: "main", image: "busybox" }] } } },
            },
          ],
        };
      },
      async readControllerHealth() {
        return { available: true, ready: 1, desired: 1 };
      },
      async deleteSandbox() {},
      async deleteClaim() {},
      async patchSandboxAnnotations() {},
    };

    const provider = new KubernetesInventoryProvider(reader, { cacheTtlMs: 0 });
    const capabilities = await provider.getCapabilities();

    expect(capabilities.claims).toBe(true);
    expect(capabilities.warmPools).toBe(true);
    expect(capabilities.templates).toBe(true);
  });

  it("propagates extension access failures instead of masking them as unsupported", async () => {
    const reader: ClusterReader = {
      async listSandboxes() {
        return [];
      },
      async listPods() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listPersistentVolumeClaims() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async listClaims() {
        throw new Error("forbidden");
      },
      async listWarmPools() {
        return { supported: false, items: [] };
      },
      async listTemplates() {
        return { supported: false, items: [] };
      },
      async readControllerHealth() {
        return null;
      },
      async deleteSandbox() {},
      async deleteClaim() {},
      async patchSandboxAnnotations() {},
    };

    const provider = new KubernetesInventoryProvider(reader, { cacheTtlMs: 0 });
    await expect(provider.getSnapshot()).rejects.toThrow("forbidden");
  });

  it("patchSandboxAnnotations sends the body as an application/merge-patch+json payload", async () => {
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: "test", server: "http://127.0.0.1", skipTLSVerify: true }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const reader = new KubernetesClusterReader(kubeConfig);
    const patchSpy = vi.fn().mockResolvedValue(undefined);
    (reader as unknown as { customObjectsApi: unknown }).customObjectsApi = {
      patchNamespacedCustomObject: patchSpy,
    };

    await reader.patchSandboxAnnotations("demo", "my-sandbox", { foo: "bar" });

    expect(patchSpy).toHaveBeenCalledTimes(1);
    const [body, options] = patchSpy.mock.calls[0]!;
    expect(body).toMatchObject({
      group: "agents.x-k8s.io",
      version: "v1alpha1",
      namespace: "demo",
      name: "my-sandbox",
      plural: "sandboxes",
      body: { metadata: { annotations: { foo: "bar" } } },
    });
    // setHeaderOptions returns a ConfigurationOptions object whose middleware
    // tacks on the Content-Type header; assert by invoking it against a fake context.
    expect(options).toBeTruthy();
    expect(options.middleware ?? options.promiseMiddleware).toBeDefined();
    const middleware = (options.middleware ?? options.promiseMiddleware)[0];
    const headers: Record<string, string> = {};
    const ctx = { setHeaderParam: (key: string, value: string) => { headers[key] = value; } };
    const maybePromise = middleware.pre(ctx);
    if (maybePromise && typeof (maybePromise as { then?: unknown }).then === "function") {
      await maybePromise;
    }
    expect(headers["Content-Type"]).toBe(k8s.PatchStrategy.MergePatch);
  });

  it("wraps K8s patch failures with namespace/name context", async () => {
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: "test", server: "http://127.0.0.1", skipTLSVerify: true }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const reader = new KubernetesClusterReader(kubeConfig);
    (reader as unknown as { customObjectsApi: unknown }).customObjectsApi = {
      patchNamespacedCustomObject: vi.fn().mockRejectedValue(new Error("conflict")),
    };

    await expect(reader.patchSandboxAnnotations("demo", "broken", {})).rejects.toThrow(
      /patchSandboxAnnotations demo\/broken failed: conflict/,
    );
  });
});
