import * as k8s from "@kubernetes/client-node";
import { existsSync } from "node:fs";
import type {
  Capabilities,
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

  constructor(kubeConfig: k8s.KubeConfig) {
    this.customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    this.coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.eventsApi = kubeConfig.makeApiClient(k8s.EventsV1Api);
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
}

export class KubernetesInventoryProvider implements InventoryProvider {
  private readonly cacheTtlMs: number;
  private readonly reader: ClusterReader;
  private cache?: { expiresAt: number; snapshot: InventorySnapshot };

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

    const [sandboxes, pods, services, pvcs, events, claims, warmPools, templates] = await Promise.all([
      this.reader.listSandboxes(),
      this.reader.listPods(),
      this.reader.listServices(),
      this.reader.listPersistentVolumeClaims(),
      this.reader.listEvents(),
      this.reader.listClaims(),
      this.reader.listWarmPools(),
      this.reader.listTemplates(),
    ]);

    const snapshot: InventorySnapshot = {
      capabilities: {
        sandboxes: true,
        claims: claims.supported,
        warmPools: warmPools.supported,
        templates: templates.supported,
        events: true,
      },
      sandboxes,
      claims: claims.items,
      warmPools: warmPools.items,
      templates: templates.items,
      pods,
      services,
      pvcs,
      events,
    };

    this.cache = {
      expiresAt: now + this.cacheTtlMs,
      snapshot,
    };

    return snapshot;
  }
}

export function createKubernetesInventoryProvider(env: NodeJS.ProcessEnv = process.env): KubernetesInventoryProvider {
  return new KubernetesInventoryProvider(new KubernetesClusterReader(createKubeConfig(env)));
}
