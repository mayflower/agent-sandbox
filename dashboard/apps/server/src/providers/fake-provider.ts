import type { InventoryProvider, InventorySnapshot, Capabilities } from "@agent-sandbox/dashboard-shared";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";

export interface FakeInventoryProviderOptions {
  snapshot?: InventorySnapshot;
  capabilities?: Partial<Capabilities>;
  deleteSandbox?: (namespace: string, name: string) => Promise<void>;
  deleteClaim?: (namespace: string, name: string) => Promise<void>;
  reconcileSandbox?: (namespace: string, name: string) => Promise<void>;
  setSandboxReplicas?: (namespace: string, name: string, replicas: number) => Promise<void>;
  patchClaimLifecycle?: (
    namespace: string,
    name: string,
    lifecycle: { shutdownTime?: string },
  ) => Promise<void>;
}

/** In-memory provider for development and tests. Mutations apply against the
 *  internal snapshot so the dashboard polling loop reflects the change on
 *  the next refresh tick. */
export class FakeInventoryProvider implements InventoryProvider {
  private snapshot: InventorySnapshot;
  readonly deleteSandbox: (namespace: string, name: string) => Promise<void>;
  readonly deleteClaim: (namespace: string, name: string) => Promise<void>;
  readonly reconcileSandbox: (namespace: string, name: string) => Promise<void>;
  readonly setSandboxReplicas: (namespace: string, name: string, replicas: number) => Promise<void>;
  readonly patchClaimLifecycle: (
    namespace: string,
    name: string,
    lifecycle: { shutdownTime?: string },
  ) => Promise<void>;

  constructor(options?: FakeInventoryProviderOptions) {
    this.snapshot =
      options?.snapshot ??
      createFixtureSnapshot(options?.capabilities ? { capabilities: options.capabilities } : {});

    this.deleteSandbox =
      options?.deleteSandbox ??
      (async (namespace: string, name: string) => {
        this.snapshot = {
          ...this.snapshot,
          sandboxes: this.snapshot.sandboxes.filter(
            (entry) => !((entry.metadata.namespace ?? "default") === namespace && entry.metadata.name === name),
          ),
        };
      });

    this.deleteClaim =
      options?.deleteClaim ??
      (async (namespace: string, name: string) => {
        this.snapshot = {
          ...this.snapshot,
          claims: this.snapshot.claims.filter(
            (entry) => !((entry.metadata.namespace ?? "default") === namespace && entry.metadata.name === name),
          ),
        };
      });

    this.reconcileSandbox =
      options?.reconcileSandbox ??
      (async () => {
        /* no-op for fake */
      });

    this.setSandboxReplicas =
      options?.setSandboxReplicas ??
      (async (namespace: string, name: string, replicas: number) => {
        this.snapshot = {
          ...this.snapshot,
          sandboxes: this.snapshot.sandboxes.map((entry) =>
            (entry.metadata.namespace ?? "default") === namespace && entry.metadata.name === name
              ? { ...entry, spec: { ...entry.spec, replicas } }
              : entry,
          ),
        };
      });

    this.patchClaimLifecycle =
      options?.patchClaimLifecycle ??
      (async (namespace, name, lifecycle) => {
        this.snapshot = {
          ...this.snapshot,
          claims: this.snapshot.claims.map((entry) => {
            if (!((entry.metadata.namespace ?? "default") === namespace && entry.metadata.name === name)) {
              return entry;
            }
            const next = { ...entry.spec };
            if (lifecycle.shutdownTime !== undefined) {
              next.lifecycle = { ...(entry.spec.lifecycle ?? {}), shutdownTime: lifecycle.shutdownTime };
            }
            return { ...entry, spec: next };
          }),
        };
      });
  }

  async getCapabilities(): Promise<Capabilities> {
    return this.snapshot.capabilities;
  }

  async getSnapshot(): Promise<InventorySnapshot> {
    return this.snapshot;
  }
}
