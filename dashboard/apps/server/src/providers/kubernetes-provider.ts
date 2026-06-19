import * as k8s from "@kubernetes/client-node";
import { existsSync } from "node:fs";
import type {
  Capabilities,
  ControllerHealth,
  InventoryProvider,
  InventorySnapshot,
  RawEvent,
  RawNamespace,
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
  /** Returns `undefined` when the underlying RBAC denies listing namespaces;
   *  the identity middleware treats that as a fatal tenancy misconfiguration. */
  listNamespaces?(): Promise<RawNamespace[] | undefined>;
  readControllerHealth(): Promise<ControllerHealth | null>;
  deleteSandbox(namespace: string, name: string): Promise<void>;
  deleteClaim(namespace: string, name: string): Promise<void>;
  patchSandboxAnnotations(namespace: string, name: string, annotations: Record<string, string>): Promise<void>;
  patchSandboxReplicas?(namespace: string, name: string, replicas: number): Promise<void>;
  patchClaimLifecycle?(namespace: string, name: string, lifecycle: { shutdownTime?: string }): Promise<void>;
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
    const status = httpStatusCodeOf(error);
    // 404 = CRD isn't installed on the cluster (older controller). 403 = the
    // dashboard's ServiceAccount lacks list/watch on the CRD. Both degrade
    // the dashboard to "this kind isn't visible" rather than tanking the
    // whole snapshot via Promise.all — the core sandbox view keeps working.
    if (status === 404 || status === 403) {
      return {
        supported: false,
        items: [],
      };
    }
    throw error;
  }
}

function httpStatusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = (error as { statusCode?: unknown; code?: unknown }).statusCode ?? (error as { code?: unknown }).code;
  return typeof candidate === "number" ? candidate : undefined;
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
      const status = httpStatusCodeOf(error);
      if (status === 404) {
        return null;
      }
      if (status === 403) {
        // RBAC denied — surface as a degraded health rather than "absent" so
        // the operator can see that the dashboard's SA is missing permissions.
        return {
          available: false,
          ready: 0,
          desired: 0,
          reason: "controller health forbidden (RBAC)",
        };
      }
      throw error;
    }
  }

  async listSandboxes(): Promise<RawSandbox[]> {
    const response = await this.customObjectsApi.listClusterCustomObject({
      group: "agents.x-k8s.io",
      version: "v1beta1",
      plural: "sandboxes",
    });
    return asItems<RawSandbox>(response);
  }

  async listPods(): Promise<RawPod[]> {
    const response = await this.coreApi.listPodForAllNamespaces();
    return response.items as unknown as RawPod[];
  }

  async listServices(): Promise<RawService[]> {
    const response = await this.coreApi.listServiceForAllNamespaces();
    return response.items as unknown as RawService[];
  }

  async listPersistentVolumeClaims(): Promise<RawPersistentVolumeClaim[]> {
    const response = await this.coreApi.listPersistentVolumeClaimForAllNamespaces();
    return response.items as unknown as RawPersistentVolumeClaim[];
  }

  async listEvents(): Promise<RawEvent[]> {
    const response = await this.eventsApi.listEventForAllNamespaces();
    return response.items as unknown as RawEvent[];
  }

  async listNamespaces(): Promise<RawNamespace[] | undefined> {
    try {
      const response = await this.coreApi.listNamespace();
      return response.items.map((item) => ({
        name: item.metadata?.name ?? "",
        labels: item.metadata?.labels ?? {},
      })).filter((entry) => entry.name !== "");
    } catch (error) {
      // 403 means the dashboard's RBAC doesn't grant Namespace list — tenancy
      // can't resolve. Return undefined so the identity middleware fails
      // closed; other errors propagate to the poll loop's health surface.
      if (httpStatusCodeOf(error) === 403) {
        return undefined;
      }
      throw error;
    }
  }

  async listClaims(): Promise<SupportedList<RawSandboxClaim>> {
    return safeListCustomObject(async () =>
      this.customObjectsApi.listClusterCustomObject({
        group: "extensions.agents.x-k8s.io",
        version: "v1beta1",
        plural: "sandboxclaims",
      }),
    );
  }

  async listWarmPools(): Promise<SupportedList<RawSandboxWarmPool>> {
    return safeListCustomObject(async () =>
      this.customObjectsApi.listClusterCustomObject({
        group: "extensions.agents.x-k8s.io",
        version: "v1beta1",
        plural: "sandboxwarmpools",
      }),
    );
  }

  async listTemplates(): Promise<SupportedList<RawSandboxTemplate>> {
    return safeListCustomObject(async () =>
      this.customObjectsApi.listClusterCustomObject({
        group: "extensions.agents.x-k8s.io",
        version: "v1beta1",
        plural: "sandboxtemplates",
      }),
    );
  }

  async deleteSandbox(namespace: string, name: string): Promise<void> {
    await this.customObjectsApi.deleteNamespacedCustomObject({
      group: "agents.x-k8s.io",
      version: "v1beta1",
      namespace,
      plural: "sandboxes",
      name,
    });
  }

  async deleteClaim(namespace: string, name: string): Promise<void> {
    await this.customObjectsApi.deleteNamespacedCustomObject({
      group: "extensions.agents.x-k8s.io",
      version: "v1beta1",
      namespace,
      plural: "sandboxclaims",
      name,
    });
  }

  async patchSandboxAnnotations(namespace: string, name: string, annotations: Record<string, string>): Promise<void> {
    try {
      await this.customObjectsApi.patchNamespacedCustomObject(
        {
          group: "agents.x-k8s.io",
          version: "v1beta1",
          namespace,
          plural: "sandboxes",
          name,
          body: { metadata: { annotations } },
        },
        k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`patchSandboxAnnotations ${namespace}/${name} failed: ${message}`, { cause: error });
    }
  }

  async patchSandboxReplicas(namespace: string, name: string, replicas: number): Promise<void> {
    await this.customObjectsApi.patchNamespacedCustomObject(
      {
        group: "agents.x-k8s.io",
        version: "v1beta1",
        namespace,
        plural: "sandboxes",
        name,
        body: { spec: { replicas } },
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );
  }

  async patchClaimLifecycle(
    namespace: string,
    name: string,
    lifecycle: { shutdownTime?: string },
  ): Promise<void> {
    await this.customObjectsApi.patchNamespacedCustomObject(
      {
        group: "extensions.agents.x-k8s.io",
        version: "v1beta1",
        namespace,
        plural: "sandboxclaims",
        name,
        body: { spec: { lifecycle } },
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );
  }
}

export class KubernetesInventoryProvider implements InventoryProvider {
  private readonly cacheTtlMs: number;
  private readonly reader: ClusterReader;
  private cache: { expiresAt: number; snapshot: InventorySnapshot } | undefined;
  private inflight: Promise<InventorySnapshot> | undefined;

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
    const namespacesPromise = this.reader.listNamespaces?.() ?? Promise.resolve(undefined);
    const [sandboxes, pods, services, pvcs, events, claims, warmPools, templates, controllerHealth, namespaces] = await Promise.all([
      this.reader.listSandboxes(),
      this.reader.listPods(),
      this.reader.listServices(),
      this.reader.listPersistentVolumeClaims(),
      this.reader.listEvents(),
      this.reader.listClaims(),
      this.reader.listWarmPools(),
      this.reader.listTemplates(),
      this.reader.readControllerHealth(),
      namespacesPromise,
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
      ...(namespaces !== undefined ? { namespaces } : {}),
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

  async setSandboxReplicas(namespace: string, name: string, replicas: number): Promise<void> {
    if (!this.reader.patchSandboxReplicas) {
      throw new Error("patchSandboxReplicas not supported by this reader");
    }
    await this.reader.patchSandboxReplicas(namespace, name, replicas);
    this.invalidate();
  }

  async patchClaimLifecycle(
    namespace: string,
    name: string,
    lifecycle: { shutdownTime?: string },
  ): Promise<void> {
    if (!this.reader.patchClaimLifecycle) {
      throw new Error("patchClaimLifecycle not supported by this reader");
    }
    await this.reader.patchClaimLifecycle(namespace, name, lifecycle);
    this.invalidate();
  }
}

export function createKubernetesInventoryProvider(env: NodeJS.ProcessEnv = process.env): KubernetesInventoryProvider {
  return new KubernetesInventoryProvider(new KubernetesClusterReader(createKubeConfig(env)));
}
