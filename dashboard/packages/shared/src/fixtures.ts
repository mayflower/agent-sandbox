import type {
  Capabilities,
  InventorySnapshot,
  RawEvent,
  RawPersistentVolumeClaim,
  RawPod,
  RawSandbox,
  RawSandboxClaim,
  RawSandboxTemplate,
  RawSandboxWarmPool,
  RawService,
} from "./types.js";

const baseCapabilities: Capabilities = {
  sandboxes: true,
  claims: true,
  warmPools: true,
  templates: true,
  events: true,
};

export function createFixtureCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    ...baseCapabilities,
    ...overrides,
    sandboxes: true,
  };
}

function createSandboxes(): RawSandbox[] {
  return [
    {
      metadata: {
        name: "claim-ready",
        namespace: "demo",
        creationTimestamp: "2026-04-15T08:00:00Z",
        annotations: {
          "agents.x-k8s.io/sandbox-template-ref": "python-secure",
          "agents.x-k8s.io/pod-name": "claim-ready",
        },
        ownerReferences: [
          {
            apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
            kind: "SandboxClaim",
            name: "quick-claim",
            controller: true,
          },
        ],
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [
              {
                name: "main",
                image: "busybox:1.36",
                ports: [{ containerPort: 8888 }],
              },
            ],
          },
        },
        volumeClaimTemplates: [{ metadata: { name: "workspace" } }],
        replicas: 1,
      },
      status: {
        service: "claim-ready",
        serviceFQDN: "claim-ready.demo.svc.cluster.local",
        podIPs: ["10.0.0.10"],
        replicas: 1,
        conditions: [{ type: "Ready", status: "True", reason: "PodReady" }],
      },
    },
    {
      metadata: {
        name: "retained-sbx",
        namespace: "demo",
        creationTimestamp: "2026-04-14T08:00:00Z",
        annotations: {
          "agents.x-k8s.io/sandbox-template-ref": "python-secure",
        },
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [{ name: "main", image: "busybox:1.36" }],
          },
        },
        shutdownPolicy: "Retain",
        shutdownTime: "2026-04-15T09:00:00Z",
        replicas: 0,
      },
      status: {
        replicas: 0,
        conditions: [{ type: "Ready", status: "False", reason: "SandboxExpired" }],
      },
    },
    {
      metadata: {
        name: "mismatch-sbx",
        namespace: "demo",
        creationTimestamp: "2026-04-15T10:00:00Z",
        annotations: {
          "agents.x-k8s.io/sandbox-template-ref": "custom-net",
          "agents.x-k8s.io/pod-name": "mismatch-sbx",
        },
        ownerReferences: [
          {
            apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
            kind: "SandboxClaim",
            name: "mismatch-claim",
            controller: true,
          },
        ],
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [{ name: "main", image: "python:3.12" }],
          },
        },
        replicas: 1,
      },
      status: {
        service: "mismatch-sbx",
        serviceFQDN: "mismatch-sbx.demo.svc.cluster.local",
        replicas: 1,
        conditions: [{ type: "Ready", status: "False", reason: "PodMissing" }],
      },
    },
    {
      metadata: {
        name: "pool-sbx-ready",
        namespace: "demo",
        creationTimestamp: "2026-04-15T07:45:00Z",
        annotations: {
          "agents.x-k8s.io/sandbox-template-ref": "python-secure",
          "agents.x-k8s.io/pod-name": "pool-sbx-ready",
        },
        labels: {
          "agents.x-k8s.io/warm-pool-sandbox": "hash-fast-pool",
        },
        ownerReferences: [
          {
            apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
            kind: "SandboxWarmPool",
            name: "fast-pool",
            controller: true,
          },
        ],
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [{ name: "main", image: "busybox:1.36" }],
          },
        },
        replicas: 1,
      },
      status: {
        podIPs: ["10.0.0.20"],
        replicas: 1,
        conditions: [{ type: "Ready", status: "True", reason: "WarmPoolReady" }],
      },
    },
    {
      metadata: {
        name: "orphan-template-ref",
        namespace: "demo",
        creationTimestamp: "2026-04-15T10:30:00Z",
        annotations: {
          "agents.x-k8s.io/sandbox-template-ref": "ghost-template",
          "agents.x-k8s.io/pod-name": "orphan-template-ref",
        },
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [{ name: "main", image: "busybox:1.36" }],
          },
        },
        replicas: 1,
      },
      status: {
        replicas: 0,
        conditions: [{ type: "Ready", status: "False", reason: "PendingPod" }],
      },
    },
  ];
}

function createClaims(): RawSandboxClaim[] {
  return [
    {
      metadata: {
        name: "quick-claim",
        namespace: "demo",
        creationTimestamp: "2026-04-15T08:00:00Z",
      },
      spec: {
        sandboxTemplateRef: { name: "python-secure" },
        warmpool: "default",
      },
      status: {
        conditions: [{ type: "Ready", status: "True", reason: "SandboxReady" }],
        sandbox: {
          name: "claim-ready",
          podIPs: ["10.0.0.10"],
        },
      },
    },
    {
      metadata: {
        name: "mismatch-claim",
        namespace: "demo",
        creationTimestamp: "2026-04-15T10:00:00Z",
      },
      spec: {
        sandboxTemplateRef: { name: "custom-net" },
        warmpool: "none",
        lifecycle: {
          shutdownPolicy: "DeleteForeground",
        },
      },
      status: {
        conditions: [{ type: "Ready", status: "True", reason: "SandboxAssigned" }],
        sandbox: {
          name: "mismatch-sbx",
        },
      },
    },
    {
      metadata: {
        name: "pending-claim",
        namespace: "demo",
        creationTimestamp: "2026-04-15T11:00:00Z",
      },
      spec: {
        sandboxTemplateRef: { name: "ghost-template" },
        warmpool: "fast-pool",
      },
      status: {
        conditions: [{ type: "Ready", status: "False", reason: "TemplatePending" }],
      },
    },
  ];
}

function createWarmPools(): RawSandboxWarmPool[] {
  return [
    {
      metadata: {
        name: "fast-pool",
        namespace: "demo",
        creationTimestamp: "2026-04-15T07:30:00Z",
      },
      spec: {
        replicas: 2,
        sandboxTemplateRef: { name: "python-secure" },
        updateStrategy: { type: "Recreate" },
      },
      status: {
        replicas: 2,
        readyReplicas: 1,
        selector: "agents.x-k8s.io/warm-pool-sandbox=hash-fast-pool",
      },
    },
  ];
}

function createTemplates(): RawSandboxTemplate[] {
  return [
    {
      metadata: {
        name: "python-secure",
        namespace: "demo",
        creationTimestamp: "2026-04-14T10:00:00Z",
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [{ name: "main", image: "busybox:1.36", ports: [{ containerPort: 8888 }] }],
          },
        },
        networkPolicyManagement: "Managed",
      },
    },
    {
      metadata: {
        name: "custom-net",
        namespace: "demo",
        creationTimestamp: "2026-04-14T11:00:00Z",
      },
      spec: {
        podTemplate: {
          spec: {
            automountServiceAccountToken: true,
            containers: [{ name: "main", image: "python:3.12", ports: [{ containerPort: 8080 }] }],
          },
        },
        networkPolicyManagement: "Managed",
        networkPolicy: {
          ingress: [{}],
        },
      },
    },
    {
      metadata: {
        name: "external-template",
        namespace: "demo",
        creationTimestamp: "2026-04-14T12:00:00Z",
      },
      spec: {
        podTemplate: {
          spec: {
            containers: [{ name: "main", image: "node:22", ports: [{ containerPort: 3000 }] }],
          },
        },
        networkPolicyManagement: "Unmanaged",
      },
    },
  ];
}

function createPods(): RawPod[] {
  return [
    {
      metadata: {
        name: "claim-ready",
        namespace: "demo",
        creationTimestamp: "2026-04-15T08:00:30Z",
        ownerReferences: [
          {
            apiVersion: "agents.x-k8s.io/v1alpha1",
            kind: "Sandbox",
            name: "claim-ready",
            controller: true,
          },
        ],
      },
      spec: {
        nodeName: "node-a",
      },
      status: {
        phase: "Running",
        podIP: "10.0.0.10",
        podIPs: [{ ip: "10.0.0.10" }],
        conditions: [{ type: "Ready", status: "True", reason: "ContainersReady" }],
      },
    },
    {
      metadata: {
        name: "pool-sbx-ready",
        namespace: "demo",
        creationTimestamp: "2026-04-15T07:45:30Z",
        ownerReferences: [
          {
            apiVersion: "agents.x-k8s.io/v1alpha1",
            kind: "Sandbox",
            name: "pool-sbx-ready",
            controller: true,
          },
        ],
      },
      spec: {
        nodeName: "node-b",
      },
      status: {
        phase: "Running",
        podIP: "10.0.0.20",
        podIPs: [{ ip: "10.0.0.20" }],
        conditions: [{ type: "Ready", status: "True", reason: "ContainersReady" }],
      },
    },
  ];
}

function createServices(): RawService[] {
  return [
    {
      metadata: {
        name: "claim-ready",
        namespace: "demo",
      },
    },
    {
      metadata: {
        name: "mismatch-sbx",
        namespace: "demo",
      },
    },
  ];
}

function createPvcs(): RawPersistentVolumeClaim[] {
  return [
    {
      metadata: {
        name: "workspace-claim-ready",
        namespace: "demo",
        ownerReferences: [
          {
            apiVersion: "agents.x-k8s.io/v1alpha1",
            kind: "Sandbox",
            name: "claim-ready",
            controller: true,
          },
        ],
      },
    },
  ];
}

function createEvents(): RawEvent[] {
  return [
    {
      metadata: {
        name: "claim-ready-ready.1",
        namespace: "demo",
      },
      type: "Normal",
      reason: "Ready",
      message: "Sandbox became ready",
      eventTime: "2026-04-15T08:01:00Z",
      regarding: {
        kind: "Sandbox",
        name: "claim-ready",
        namespace: "demo",
      },
    },
    {
      metadata: {
        name: "mismatch-claim-warning.1",
        namespace: "demo",
      },
      type: "Warning",
      reason: "RuntimeMissing",
      message: "Claim runtime has no running sandbox pod",
      eventTime: "2026-04-15T10:05:00Z",
      regarding: {
        kind: "SandboxClaim",
        name: "mismatch-claim",
        namespace: "demo",
      },
    },
  ];
}

export function createFixtureSnapshot(options?: { capabilities?: Partial<Capabilities> }): InventorySnapshot {
  const capabilities = createFixtureCapabilities(options?.capabilities);

  const claims = capabilities.claims ? createClaims() : [];
  const warmPools = capabilities.warmPools ? createWarmPools() : [];
  const templates = capabilities.templates ? createTemplates() : [];

  return {
    capabilities,
    sandboxes: createSandboxes(),
    claims,
    warmPools,
    templates,
    pods: createPods(),
    services: createServices(),
    pvcs: createPvcs(),
    events: createEvents(),
  };
}
