import type { InventoryProvider, InventorySnapshot, Capabilities } from "@agent-sandbox/dashboard-shared";
import { createFixtureSnapshot } from "@agent-sandbox/dashboard-shared";

export class FakeInventoryProvider implements InventoryProvider {
  private readonly snapshot: InventorySnapshot;

  constructor(options?: { snapshot?: InventorySnapshot; capabilities?: Partial<Capabilities> }) {
    this.snapshot = options?.snapshot ?? createFixtureSnapshot({ capabilities: options?.capabilities });
  }

  async getCapabilities(): Promise<Capabilities> {
    return this.snapshot.capabilities;
  }

  async getSnapshot(): Promise<InventorySnapshot> {
    return this.snapshot;
  }
}
