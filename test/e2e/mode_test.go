// Copyright 2025 The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package e2e

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	sandboxv1beta1 "sigs.k8s.io/agent-sandbox/api/v1beta1"
	"sigs.k8s.io/agent-sandbox/test/e2e/framework"
	"sigs.k8s.io/agent-sandbox/test/e2e/framework/predicates"
)

func TestSandboxOperatingMode(t *testing.T) {
	tc := framework.NewTestContext(t)

	// Set up a namespace
	ns := &corev1.Namespace{}
	ns.Name = fmt.Sprintf("my-sandbox-ns-%d", time.Now().UnixNano())
	require.NoError(t, tc.CreateWithCleanup(t.Context(), ns))
	// Create a Sandbox Object
	sandboxObj := simpleSandbox(ns.Name)
	sandboxObj.Spec.OperatingMode = sandboxv1beta1.SandboxOperatingModeRunning
	require.NoError(t, tc.CreateWithCleanup(t.Context(), sandboxObj))

	nameHash := NameHash(sandboxObj.Name)
	// Assert Sandbox object status reconciles as expected
	p := []predicates.ObjectPredicate{
		predicates.SandboxHasStatus(sandboxv1beta1.SandboxStatus{
			Service:       "my-sandbox",
			ServiceFQDN:   fmt.Sprintf("my-sandbox.%s.svc.cluster.local", ns.Name),
			LabelSelector: "agents.x-k8s.io/sandbox-name-hash=" + nameHash,
			Conditions: []metav1.Condition{
				{
					Type:               "Ready",
					Status:             metav1.ConditionTrue,
					ObservedGeneration: 1,
					Reason:             sandboxv1beta1.SandboxReasonDependenciesReady,
					Message:            "Pod is Ready; Service Exists",
				},
			},
		}),
	}
	tc.MustWaitForObject(sandboxObj, p...)
	// Assert Pod and Service objects exist
	pod := &corev1.Pod{}
	pod.Name = "my-sandbox"
	pod.Namespace = ns.Name
	tc.MustExist(pod)

	service := &corev1.Service{}
	service.Name = "my-sandbox"
	service.Namespace = ns.Name
	tc.MustExist(service)

	// Set operating mode to suspended
	framework.MustUpdateObject(tc.ClusterClient, sandboxObj, func(obj *sandboxv1beta1.Sandbox) {
		obj.Spec.OperatingMode = sandboxv1beta1.SandboxOperatingModeSuspended
	})

	// Wait for sandbox status to reflect new state
	p = []predicates.ObjectPredicate{
		predicates.SandboxHasStatus(sandboxv1beta1.SandboxStatus{
			Service:       "my-sandbox",
			ServiceFQDN:   fmt.Sprintf("my-sandbox.%s.svc.cluster.local", ns.Name),
			LabelSelector: "agents.x-k8s.io/sandbox-name-hash=" + nameHash,
			Conditions: []metav1.Condition{
				{
					Type:               "Ready",
					Status:             metav1.ConditionFalse,
					ObservedGeneration: 2,
					Reason:             sandboxv1beta1.SandboxReasonSuspended,
					Message:            "Sandbox is suspended",
				},
				{
					Type:               string(sandboxv1beta1.SandboxConditionSuspended),
					Status:             metav1.ConditionTrue,
					ObservedGeneration: 2,
					Reason:             sandboxv1beta1.SandboxReasonSuspendedPodTerminated,
					Message:            "Pod has been terminated. Sandbox is not operational.",
				},
			},
		}),
	}
	tc.MustWaitForObject(sandboxObj, p...)
	// Verify Pod is deleted but Service still exists
	require.NoError(t, tc.WaitForObjectNotFound(t.Context(), pod))
	tc.MustMatchPredicates(service, predicates.NotDeleted())
}

func TestSandboxSuspendWithPersistentStorage(t *testing.T) {
	tc := framework.NewTestContext(t)

	ns := &corev1.Namespace{}
	ns.Name = fmt.Sprintf("sandbox-persistent-suspend-test-%d", time.Now().UnixNano())
	require.NoError(t, tc.CreateWithCleanup(t.Context(), ns))

	bootstrapFromImage := false
	storageSize := resource.MustParse("1Gi")
	sandboxObj := simpleSandbox(ns.Name)
	sandboxObj.Spec.PersistentStorage = &sandboxv1beta1.PersistentStorageSpec{
		Size: &storageSize,
		Mounts: []sandboxv1beta1.PersistentMount{
			{
				Path:               "/workspace",
				BootstrapFromImage: &bootstrapFromImage,
			},
		},
	}
	require.NoError(t, tc.CreateWithCleanup(t.Context(), sandboxObj))

	tc.MustWaitForObject(sandboxObj, predicates.ReadyConditionIsTrue)

	pvc := &corev1.PersistentVolumeClaim{}
	pvc.Name = sandboxObj.Name + "-persist"
	pvc.Namespace = ns.Name
	tc.MustExist(pvc)

	pod := &corev1.Pod{}
	pod.Name = sandboxObj.Name
	pod.Namespace = ns.Name
	tc.MustExist(pod)

	framework.MustUpdateObject(tc.ClusterClient, sandboxObj, func(obj *sandboxv1beta1.Sandbox) {
		obj.Spec.OperatingMode = sandboxv1beta1.SandboxOperatingModeSuspended
	})

	tc.MustWaitForObject(
		sandboxObj,
		predicates.ConditionReasonEquals(string(sandboxv1beta1.SandboxConditionReady), sandboxv1beta1.SandboxReasonSuspended),
		predicates.ConditionReasonEquals(string(sandboxv1beta1.SandboxConditionSuspended), sandboxv1beta1.SandboxReasonSuspendedPodTerminated),
	)
	require.NoError(t, tc.WaitForObjectNotFound(t.Context(), pod))
	tc.MustExist(pvc)

	framework.MustUpdateObject(tc.ClusterClient, sandboxObj, func(obj *sandboxv1beta1.Sandbox) {
		obj.Spec.OperatingMode = sandboxv1beta1.SandboxOperatingModeRunning
	})

	tc.MustWaitForObject(sandboxObj, predicates.ReadyConditionIsTrue)
	tc.MustExist(pvc)
	tc.MustExist(pod)
}
