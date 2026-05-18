---
title: "persistentStorage"
linkTitle: "persistentStorage"
weight: 10
description: >
  Preserve selected filesystem paths across Sandbox pod restarts and suspend/resume cycles.
---

`persistentStorage` gives a Sandbox a durable filesystem layer without asking the user to define Kubernetes volumes and mounts by hand. It is the first concrete filesystem-layer snapshot provider for the suspend and snapshot work tracked in [issue #694](https://github.com/kubernetes-sigs/agent-sandbox/issues/694): when the Sandbox pod is deleted, recreated, or suspended with `spec.operatingMode: Suspended`, selected filesystem paths remain on a PVC and are mounted again when the Sandbox resumes.

This is filesystem persistence only. It does not snapshot running processes, memory, sockets, kernel state, or the full container root filesystem.

## How It Works

When `spec.persistentStorage` is set, the Sandbox controller creates exactly one PVC for each Sandbox. The PVC is owned by the Sandbox and is deleted by Kubernetes garbage collection when the Sandbox is deleted. Suspending the Sandbox deletes only the pod, not the PVC.

Each entry in `persistentStorage.mounts` becomes a mount in the first main container. All mounts share the same PVC, but each path uses a distinct `subPath` directory. For example, `/root` and `/usr/local` are backed by separate directories inside the one persistent volume.

The controller reserves its own volume and init container names for this feature. Do not define a pod volume named `agent-sandbox-persistent-storage` or an init container named `agent-sandbox-persistent-storage-bootstrap`.

If `size` is omitted, the controller chooses its default request. You can set `storageClassName` to select a specific StorageClass, or omit it to use the cluster default.

## First-Boot Bootstrap

By default, each mounted path is bootstrapped from the container image on first use. The bootstrap init container uses the first main container's image, mounts the PVC, and copies the image contents from each configured directory into the matching persistent `subPath` only when that destination is empty.

Set `bootstrapFromImage: false` for paths that should start as empty persistent directories, such as `/workspace`.

Bootstrap is intentionally non-clobbering:

* If the persistent directory already contains data, image contents are not copied again.
* Later pod restarts and suspend/resume cycles reuse the existing PVC contents.
* Updating the container image does not overwrite files that already exist in the PVC.
* Bootstrap currently supports directory paths. If a bootstrap source exists in the image and is not a directory, reconciliation fails with a clear error.

## Sandbox Example

This Sandbox persists `/workspace` as an empty work directory and bootstraps `/root` from the image on first use:

```yaml
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: persistent-storage-sandbox
spec:
  persistentStorage:
    size: 20Gi
    mounts:
    - path: /workspace
      bootstrapFromImage: false
    - path: /root
      bootstrapFromImage: true
  podTemplate:
    spec:
      containers:
      - name: shell
        image: ubuntu:24.04
        command: ["/bin/sh", "-c", "sleep infinity"]
```

The controller creates one PVC named after the Sandbox, for example:

```bash
kubectl get pvc persistent-storage-sandbox-persist
```

## SandboxTemplate Example

`SandboxTemplate` supports the same field. Sandboxes created by a `SandboxClaim` or `SandboxWarmPool` receive a deep copy of the template's `persistentStorage` configuration.

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: persistent-storage-template
spec:
  persistentStorage:
    size: 30Gi
    mounts:
    - path: /root
    - path: /usr/local
  podTemplate:
    spec:
      containers:
      - name: shell
        image: ubuntu:24.04
        command: ["/bin/sh", "-c", "sleep infinity"]
```

With a warm pool, each prewarmed Sandbox gets its own PVC. When `persistentStorage` changes in the template, the warm pool template hash changes so replacement sandboxes use the new storage shape.

## Relationship to volumeClaimTemplates

Use `persistentStorage` when you want Agent Sandbox to manage the common case: selected container paths should survive pod recreation and suspend/resume, and the controller should create the PVC, volume, volume mounts, `subPath` layout, and optional first-boot bootstrap for you.

Use [`volumeClaimTemplates`](/docs/volumes/volume-claim-template/) when you need lower-level Kubernetes volume control, multiple explicit PVC templates, custom mount names, sidecar-specific mounts, or storage that is not tied to filesystem snapshot semantics.

The two features can be used by the same Sandbox as long as their volume names and mount paths do not collide.

## Safety Rules

The controller validates persistent paths before creating PVCs or pods. It rejects:

* Empty or relative paths.
* `/`, after path normalization.
* Duplicate paths after normalization.
* Nested paths, such as `/root` together with `/root/.cache`.
* Blocked system paths: `/dev`, `/proc`, `/sys`, `/run`, `/var/run`, `/etc/passwd`, `/etc/shadow`, and host key paths matching `/etc/ssh/*_host_key*`.

These rules are intentionally conservative. `persistentStorage` is for application and agent filesystem state, not for replacing container isolation boundaries or persisting operating system internals.

## Limitations

`persistentStorage` does not preserve memory or process state. A suspended Sandbox resumes by creating a new pod that remounts the same PVC.

Full root filesystem persistence is out of scope. Persist only the paths your workload needs, such as `/workspace`, `/root`, `/home/user`, `/usr/local`, or package caches.

Image updates do not migrate or overwrite existing PVC data. If you need to reseed a path from a new image, create a new Sandbox or manually manage the existing PVC contents.
