import * as k8s from "@kubernetes/client-node";
import { existsSync } from "node:fs";
import type {
  Capabilities,
  ControllerHealth,
  InventoryProvider,
  InventorySnapshot,
  RawEvent,
  RawPersistentVolumeClaim,
  RawPod,
  RawSandbox,
  RawSandboxClaim,
  RawSandboxTemplate,
  RawSandboxWarmPool,
  RawService,
} from "@agent-sandbox/dashboard-shared";

const CONTROLLER_NAMESPACE = process.env.DASHBOARD_CONTROLLER_NAMESPACE ?? "agent-sandbox-system";
const CONTROLLER_DEPLOYMENT = process.env.DASHBOARD_CONTROLLER_DEPLOYMENT ?? "agent-sandbox-controller";

type SupportedList<T> = {
  supported: boolean;
  items: T[];
};

export interface ClusterReader {
  listSandboxes(): Promise<RawSandbox[]>;
  listPods(): Promise<RawPod[]>;
  listServices(): Promise<RawService[]>;
  listPersistentVolumeClaims(): Promise<RawPersistentVolumeClaim[]>;
  listEvents(): Promise<RawEvent[]>;
  listClaims(): Promise<SupportedList<RawSandboxClaim>>;
  listWarmPools(): Promise<SupportedList<RawSandboxWarmPool>>;
  listTemplates(): Promise<SupportedList<RawSandboxTemplate>>;
  readControllerHealth(): Promise<ControllerHealth | null>;
  deleteSandbox(namespace: string, name: string): Promise<void>;
  deleteClaim(namespace: string, name: string): Promise<void>;
  patchSandboxAnnotations(namespace: string, name: string, annotations: Record<string, string>): Promise<void>;
}

function asItems<T>(value: unknown): T[] {
  if (typeof value !== "object" || value === null || !("items" in value)) {
    return [];
  }

  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? (items as T[]) : [];
}

async function safeListCustomObject<T>(
  loader: () => Promise<unknown>,
): Promise<SupportedList<T>> {
  try {
    const response = await loader();
    return {
      supported: true,
      items: asItems<T>(response),
    };
  } catch (error) {
    if (error instanceof k8s.HttpError && error.statusCode === 404) {
      return {
        supported: false,
        items: [],
      };
    }
    throw error;
  }
}

const SERVICE_ACCOUNT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export function resolveKubeConfigMode(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync,
): "kubeconfig" | "incluster" {
  if (env.KUBECONFIG) {
    return "kubeconfig";
  }

  const hasInClusterSignals = Boolean(env.KUBERNETES_SERVICE_HOST) && fileExists(SERVICE_ACCOUNT_TOKEN_PATH);
  return hasInClusterSignals ? "incluster" : "kubeconfig";
}

export function createKubeConfig(env: NodeJS.ProcessEnv = process.env): k8s.KubeConfig {
  const kubeConfig = new k8s.KubeConfig();
  if (resolveKubeConfigMode(env) === "kubeconfig") {
    kubeConfig.loadFromDefault();
  } else {
    kubeConfig.loadFromCluster();
  }
  return kubeConfig;
}

export class KubernetesClusterReader implements ClusterReader {
  private readonly customObjectsApi: k8s.CustomObjectsApi;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly eventsApi: k8s.EventsV1Api;
  private readonly appsApi: k8s.AppsV1Api;

  constructor(kubeConfig: k8s.KubeConfig) {
    this.customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    this.coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.eventsApi = kubeConfig.makeApiClient(k8s.EventsV1Api);
    this.appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
  }

  async readControllerHealth(): Promise<ControllerHealth | null> {
    try {
      const deployment = await this.appsApi.readNamespacedDeployment({
        name: CONTROLLER_DEPLOYMENT,
        namespace: CONTROLLER_NAMESPACE,
      });
      const desired = deployment.spec?.replicas ?? 0;
      const ready = deployment.status?.readyReplicas ?? 0;
      const availableCondition = deployment.status?.conditions?.find((condition) => condition.type === "Available");
      const available = availableCondition?.status === "True" && ready >= desired;
      const health: ControllerHealth = { available, ready, desired };
      if (availableCondition?.reason) {
        health.reason = availableCondition.reason;
      }
      return health;
    } catch (error) {
      if (error instanceof k8s.HttpError && (error.statusCode === 403 || error.statusCode === 404)) {
        return null;
      }
      throw error;
    }
  }

  async listSandboxes(): Promise<RawSandbox[]> {
    const response = await this.customObjectsApi.listClusterCustomObject({
      group: "agents.x-k8s.io",
      version: "v1alpha1",
      plural: "sandboxes",
    });
    return asItems<RawSandbox>(response);
  }

  async listPods(): Promise<RawPod[]> {
    const response = await this.coreApi.listPodForAllNamespaces();
    return response.items as RawPod[];
  }

  async listServices(): Promise<RawService[]> {
    const response = await this.coreApi.listServiceForAllNamespaces();
    return response.items as RawService[];
  }

  async listPersistentVolumeClaims(): Promise<RawPersistentVolumeClaim[]> {
    const response = await this.coreApi.listPersistentVolumeClaimForAllNamespaces();
    return response.items as RawPersistentVolumeClaim[];
  }

  async listEvents(): Promise<RawEvent[]> {
    const response = await this.eventsApi.listEventForAllNamespaces();
    return response.items as RawEvent[];
  }

  async listClaims(): Promise<SupportedList<RawSandboxClaim>> {
    return safeListCustomObject(async () =>
      this.customObjectsApi.listClusterCustomObject({
        group: "extensions.agents.x-k8s.io",
        version: "v1alpha1",
        plural: "sandboxclaims",
      }),
    );
  }

  async listWarmPools(): Promise<SupportedList<RawSandboxWarmPool>> {
    return safeListCustomObject(async () =>
      this.customObjectsApi.listClusterCustomObject({
        group: "extensions.agents.x-k8s.io",
        version: "v1alpha1",
        plural: "sandboxwarmpools",
      }),
    );
  }

  async listTemplates(): Promise<SupportedList<RawSandboxTemplate>> {
    return safeListCustomObject(async () =>
      this.customObjectsApi.listClusterCustomObject({
        group: "extensions.agents.x-k8s.io",
        version: "v1alpha1",
        plural: "sandboxtemplates",
      }),
    );
  }

  async deleteSandbox(namespace: string, name: string): Promise<void> {
    await this.customObjectsApi.deleteNamespacedCustomObject({
      group: "agents.x-k8s.io",
      version: "v1alpha1",
      namespace,
      plural: "sandboxes",
      name,
    });
  }

  async deleteClaim(namespace: string, name: string): Promise<void> {
    await this.customObjectsApi.deleteNamespacedCustomObject({
      group: "extensions.agents.x-k8s.io",
      version: "v1alpha1",
      namespace,
      plural: "sandboxclaims",
      name,
    });
  }

  async patchSandboxAnnotations(namespace: string, name: string, annotations: Record<string, string>): Promise<void> {
    await this.customObjectsApi.patchNamespacedCustomObject({
      group: "agents.x-k8s.io",
      version: "v1alpha1",
      namespace,
      plural: "sandboxes",
      name,
      body: { metadata: { annotations } },
    });
  }
}

export class KubernetesInventoryProvider implements InventoryProvider {
  private readonly cacheTtlMs: number;
  private readonly reader: ClusterReader;
  private cache?: { expiresAt: number; snapshot: InventorySnapshot };
  private inflight?: Promise<InventorySnapshot>;

  constructor(reader: ClusterReader, options?: { cacheTtlMs?: number }) {
    this.reader = reader;
    this.cacheTtlMs = options?.cacheTtlMs ?? 5_000;
  }

  async getCapabilities(): Promise<Capabilities> {
    return (await this.getSnapshot()).capabilities;
  }

  async getSnapshot(): Promise<InventorySnapshot> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.snapshot;
    }
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.loadSnapshot(now).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async loadSnapshot(startedAt: number): Promise<InventorySnapshot> {
    const [sandboxes, pods, services, pvcs, events, claims, warmPools, templates, controllerHealth] = await Promise.all([
      this.reader.listSandboxes(),
      this.reader.listPods(),
      this.reader.listServices(),
      this.reader.listPersistentVolumeClaims(),
      this.reader.listEvents(),
      this.reader.listClaims(),
      this.reader.listWarmPools(),
      this.reader.listTemplates(),
      this.reader.readControllerHealth(),
    ]);

    const snapshot: InventorySnapshot = {
      capabilities: {
        sandboxes: true,
        claims: claims.supported,
        warmPools: warmPools.supported,
        templates: templates.supported,
        events: true,
        controllerHealth: controllerHealth !== null,
      },
      sandboxes,
      claims: claims.items,
      warmPools: warmPools.items,
      templates: templates.items,
      pods,
      services,
      pvcs,
      events,
      controllerHealth,
    };

    this.cache = {
      expiresAt: startedAt + this.cacheTtlMs,
      snapshot,
    };

    return snapshot;
  }

  private invalidate(): void {
    this.cache = undefined;
  }

  async deleteSandbox(namespace: string, name: string): Promise<void> {
    await this.reader.deleteSandbox(namespace, name);
    this.invalidate();
  }

  async deleteClaim(namespace: string, name: string): Promise<void> {
    await this.reader.deleteClaim(namespace, name);
    this.invalidate();
  }

  async reconcileSandbox(namespace: string, name: string): Promise<void> {
    await this.reader.patchSandboxAnnotations(namespace, name, {
      "agents.x-k8s.io/reconcile-trigger": new Date().toISOString(),
    });
    this.invalidate();
  }
}

export function createKubernetesInventoryProvider(env: NodeJS.ProcessEnv = process.env): KubernetesInventoryProvider {
  return new KubernetesInventoryProvider(new KubernetesClusterReader(createKubeConfig(env)));
}
