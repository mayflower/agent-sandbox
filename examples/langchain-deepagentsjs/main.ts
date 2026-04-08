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
 * Minimal end-to-end example: a deepagents-js agent backed by a Kubernetes
 * agent-sandbox pod.
 *
 * Prerequisites:
 *   1. A Kubernetes cluster with the agent-sandbox controller deployed.
 *   2. Apply the SandboxTemplate from sandbox-template.yaml:
 *        kubectl apply -f sandbox-template.yaml
 *   3. Set ANTHROPIC_API_KEY in the environment.
 *
 * Run:
 *   pnpm install
 *   pnpm tsx main.ts
 */

import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { K8sAgentSandbox } from "langchain-agent-sandbox";

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be set");
  }

  // Provision a fresh sandbox from the template. The TS provider uses
  // `kubectl port-forward` by default to reach the sandbox-router service,
  // so no external load balancer or ingress is required for local runs.
  const sandbox = await K8sAgentSandbox.create({
    template: "python-deepagent",
    namespace: "default",
    deleteOnClose: true,
  });

  try {
    const agent = createDeepAgent({
      model: new ChatAnthropic({
        model: "claude-sonnet-4-5",
        temperature: 0,
      }),
      systemPrompt:
        "You are a Python coding assistant. Use the sandbox to write and run Python code. " +
        "Always test your code before claiming it works.",
      backend: sandbox,
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "Write a Python function that returns the first 10 Fibonacci numbers, " +
            "save it to /app/fib.py, then run it and show me the output.",
        },
      ],
    });

    const lastMessage = result.messages[result.messages.length - 1];
    console.log("\n=== Agent response ===\n");
    console.log(
      typeof lastMessage?.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content, null, 2),
    );
  } finally {
    await sandbox.close();
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exitCode = 1;
});
