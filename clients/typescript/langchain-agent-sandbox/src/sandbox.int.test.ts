// Copyright 2026 The Kubernetes Authors.
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

/**
 * Integration tests for K8sAgentSandbox.
 *
 * These tests require:
 * - A running Kubernetes cluster with agent-sandbox deployed
 * - LANGCHAIN_SANDBOX_TEMPLATE environment variable (e.g. python-deepagent)
 * - Optionally: LANGCHAIN_NAMESPACE (default: "default")
 * - Optionally: KUBECONFIG (defaults to ~/.kube/config)
 *
 * Env-var names match the Python langchain-agent-sandbox e2e test for symmetry.
 * The legacy SANDBOX_TEMPLATE / SANDBOX_NAMESPACE names are still accepted as
 * fallbacks so existing local setups don't break.
 *
 * Run with: pnpm test:int
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  sandboxStandardTests,
  withRetry,
} from "@langchain/sandbox-standard-tests/vitest";
import os from "node:os";

import { K8sAgentSandbox } from "./index.js";

const TEST_TIMEOUT = 120_000; // 2 minutes

const CI_LABELS: Record<string, string> = {
  purpose: "integration-test",
  package: "langchain-agent-sandbox",
  node: process.version,
  os: os.platform(),
};

const template =
  process.env.LANGCHAIN_SANDBOX_TEMPLATE ?? process.env.SANDBOX_TEMPLATE;
const namespace =
  process.env.LANGCHAIN_NAMESPACE ?? process.env.SANDBOX_NAMESPACE ?? "default";

/**
 * Clean up stale integration-test sandboxes before running tests.
 */
beforeAll(async () => {
  if (!template) return;
  await K8sAgentSandbox.deleteAll(CI_LABELS, namespace);
}, TEST_TIMEOUT);

// Hand the shared standard test suite a `skip` flag when no template is
// configured. The suite's internal beforeAll hooks call our createSandbox
// callback, which can't succeed without a template, so we need to tell
// the suite to use `describe.skip` up front rather than registering its
// hooks and failing at run time. `sandboxStandardTests` supports this
// natively — see the Modal provider for the reference usage pattern.
sandboxStandardTests({
  name: "K8sAgentSandbox",
  skip: !template,
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) =>
    K8sAgentSandbox.create({
      template: template!,
      namespace,
      deleteOnClose: true,
      labels: CI_LABELS,
      ...options,
    }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => name,
});

// Use describe.skipIf so missing-env-var runs report as SKIPPED in
// the vitest output, not as PASS. The previous `if (!template) return;`
// pattern inside each `it` block let the tests show up as 5 fake-passing
// in CI dashboards even when no template was configured.
describe.skipIf(!template)("K8sAgentSandbox Provider-Specific Tests", () => {
  let sandbox: K8sAgentSandbox;

  beforeAll(async () => {
    sandbox = await withRetry(() =>
      K8sAgentSandbox.create({
        template: template!,
        namespace,
        deleteOnClose: true,
        labels: CI_LABELS,
      }),
    );
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      await sandbox?.close({ throwOnError: false });
    } catch {
      // close() with throwOnError:false should not throw, but be
      // defensive: teardown failures must not fail an otherwise-green
      // suite.
    }
  }, TEST_TIMEOUT);

  it(
    "should have a valid sandbox id",
    async () => {
      expect(sandbox.id).toBeTruthy();
      expect(typeof sandbox.id).toBe("string");
    },
    TEST_TIMEOUT,
  );

  it(
    "should report as running after creation",
    async () => {
      expect(sandbox.isRunning).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "should pass health check",
    async () => {
      const result = await sandbox.healthz();
      expect(result.ok).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "should execute a basic command",
    async () => {
      const result = await sandbox.execute("echo 'hello from k8s sandbox'");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("hello from k8s sandbox");
    },
    TEST_TIMEOUT,
  );

  it(
    "should have a claim name",
    async () => {
      expect(sandbox.claimName).toMatch(/^sandbox-claim-/);
    },
    TEST_TIMEOUT,
  );
});
