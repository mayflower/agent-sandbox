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
 * End-to-end agent test: an actual deepagents-js agent must be able to
 * complete a sandbox-backed task using K8sAgentSandbox.
 *
 * This test is the deepagents-js analog of the Python langchain-agent-sandbox
 * e2e suite. Unlike `sandbox.int.test.ts` (which exercises the backend
 * surface directly), this test instantiates a real `createDeepAgent` against
 * a real LLM and verifies the agent loop can drive the sandbox to a
 * deterministic side effect.
 *
 * Required environment:
 *   - LANGCHAIN_SANDBOX_TEMPLATE  (or legacy SANDBOX_TEMPLATE)
 *       SandboxTemplate name to provision from. Must point at an image
 *       with `cat`, `mkdir`, and a writable /app directory (the standard
 *       python-runtime-sandbox example image works).
 *   - ANTHROPIC_API_KEY
 *       Used by ChatAnthropic. The test makes a small number of LLM calls
 *       (one agent invocation, ~3-5 tool calls) per run.
 *
 * Optional environment:
 *   - LANGCHAIN_NAMESPACE  (default: "default")
 *   - LANGCHAIN_SANDBOX_AGENT_MODEL  (default: "claude-sonnet-4-5-20250929")
 *   - KUBECONFIG  (defaults to ~/.kube/config; CI sets it to bin/KUBECONFIG)
 *
 * The test skips cleanly when either required variable is unset so it
 * doesn't break local development workflows. Run with: pnpm test:int
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import os from "node:os";

import { K8sAgentSandbox } from "./index.js";

// `deepagents` and `@langchain/anthropic` are devDependencies of this
// package — they're available at int-test time but should never be
// imported from the published library code. Keeping them inside this
// test file (and not in src/) preserves the build's runtime contract.
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";

const TEST_TIMEOUT = 5 * 60_000; // 5 minutes — covers sandbox provision + agent loop

const template =
  process.env.LANGCHAIN_SANDBOX_TEMPLATE ?? process.env.SANDBOX_TEMPLATE;
const namespace =
  process.env.LANGCHAIN_NAMESPACE ?? process.env.SANDBOX_NAMESPACE ?? "default";
const apiKey = process.env.ANTHROPIC_API_KEY;
const modelName =
  process.env.LANGCHAIN_SANDBOX_AGENT_MODEL ?? "claude-sonnet-4-5-20250929";

// Vitest's `describe.skip` skips the entire suite at registration time —
// avoids `beforeAll` running and crashing on missing env vars.
const shouldSkip = !template || !apiKey;
const describeOrSkip = shouldSkip ? describe.skip : describe;

if (shouldSkip) {
  // eslint-disable-next-line no-console
  console.log(
    "[agent.int.test] Skipping deepagents-js agent e2e: " +
      (!template
        ? "LANGCHAIN_SANDBOX_TEMPLATE (or SANDBOX_TEMPLATE) is not set"
        : "ANTHROPIC_API_KEY is not set"),
  );
}

const CI_LABELS: Record<string, string> = {
  purpose: "deepagentjs-agent-e2e",
  package: "langchain-agent-sandbox",
  node: process.version,
  os: os.platform(),
};

describeOrSkip("deepagents-js agent backed by K8sAgentSandbox", () => {
  let sandbox: K8sAgentSandbox;

  beforeAll(async () => {
    // Best-effort cleanup of stale sandboxes from previous failed runs
    // before provisioning a fresh one.
    await K8sAgentSandbox.deleteAll(CI_LABELS, namespace).catch(() => {
      // Cleanup is best-effort; ignore failures here so the test can
      // still proceed against a fresh sandbox.
    });

    sandbox = await K8sAgentSandbox.create({
      template: template!,
      namespace,
      deleteOnClose: true,
      labels: CI_LABELS,
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      await sandbox?.close();
    } catch {
      // Cleanup is best-effort during teardown — the deleteOnClose flag
      // also covers this on the sandbox controller side.
    }
  }, TEST_TIMEOUT);

  it(
    "completes a deterministic file-write task and the side effect is verifiable",
    async () => {
      // Generate a per-run marker the agent has no prior knowledge of.
      // The marker MUST appear verbatim in the file the agent writes,
      // which is how we know the test result reflects this run rather
      // than a leftover artifact from a previous one.
      const marker = `DEEPAGENT_E2E_OK_${randomUUID()}`;
      const targetPath = "/app/agent_e2e_marker.txt";

      const agent = createDeepAgent({
        model: new ChatAnthropic({
          model: modelName,
          temperature: 0,
          // Limit per-call thinking to keep the loop tight in CI.
          maxTokens: 2048,
        }),
        systemPrompt:
          "You are a sandbox automation agent. Use the sandbox tools to " +
          "complete the user's request literally and concisely. When you " +
          "are asked to write a file, write it exactly as instructed and " +
          "then confirm by reading it back.",
        backend: sandbox,
      });

      const result = await agent.invoke({
        messages: [
          {
            role: "user",
            content:
              `Write the exact text "${marker}" to the file at ${targetPath}. ` +
              `After writing, read the file back to confirm its contents, ` +
              `then reply with the word DONE.`,
          },
        ],
      });

      // Sanity check that the agent loop terminated with at least one
      // assistant message — no assertion on the content because LLM
      // wording varies. Real verification happens via the sandbox below.
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);

      // Independent verification of the side effect: read the file
      // through `execute` (not through the agent) to confirm the marker
      // is actually present in the sandbox filesystem. This is the only
      // assertion that proves the agent actually drove the backend to
      // do the work.
      const cat = await sandbox.execute(`cat ${targetPath}`);
      expect(cat.exitCode).toBe(0);
      expect(cat.output).toContain(marker);
    },
    TEST_TIMEOUT,
  );
});
