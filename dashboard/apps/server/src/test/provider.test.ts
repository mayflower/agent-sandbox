import { describe, expect, it } from "vitest";

import { KubernetesInventoryProvider, resolveKubeConfigMode, type ClusterReader } from "../providers/kubernetes-provider.js";

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
});
