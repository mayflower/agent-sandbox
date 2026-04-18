import type { InventoryProvider, InventorySnapshot, Capabilities } from "@agent-sandbox/dashboard-shared";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";

export interface FakeInventoryProviderOptions {
  snapshot?: InventorySnapshot;
  capabilities?: Partial<Capabilities>;
  deleteSandbox?: (namespace: string, name: string) => Promise<void>;
  deleteClaim?: (namespace: string, name: string) => Promise<void>;
  reconcileSandbox?: (namespace: string, name: string) => Promise<void>;
}

export class FakeInventoryProvider implements InventoryProvider {
  private readonly snapshot: InventorySnapshot;
  readonly deleteSandbox?: (namespace: string, name: string) => Promise<void>;
  readonly deleteClaim?: (namespace: string, name: string) => Promise<void>;
  readonly reconcileSandbox?: (namespace: string, name: string) => Promise<void>;

  constructor(options?: FakeInventoryProviderOptions) {
    this.snapshot = options?.snapshot ?? createFixtureSnapshot({ capabilities: options?.capabilities });
    if (options?.deleteSandbox) this.deleteSandbox = options.deleteSandbox;
    if (options?.deleteClaim) this.deleteClaim = options.deleteClaim;
    if (options?.reconcileSandbox) this.reconcileSandbox = options.reconcileSandbox;
  }

  async getCapabilities(): Promise<Capabilities> {
    return this.snapshot.capabilities;
  }

  async getSnapshot(): Promise<InventorySnapshot> {
    return this.snapshot;
  }
}
