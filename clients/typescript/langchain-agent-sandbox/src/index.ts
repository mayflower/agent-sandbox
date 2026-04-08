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
 * langchain-agent-sandbox
 *
 * Kubernetes agent-sandbox backend for deepagents-js.
 *
 * This package provides a Kubernetes-native implementation of the deepagents
 * SandboxBackendProtocol, enabling agents to execute commands, read/write
 * files, and manage isolated sandbox environments backed by sandbox pods
 * managed by the kubernetes-sigs/agent-sandbox controller.
 *
 * @example
 * ```typescript
 * import { K8sAgentSandbox } from "langchain-agent-sandbox";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Connect to an existing sandbox by URL
 * const sandbox = K8sAgentSandbox.fromUrl(
 *   "http://localhost:8080",
 *   "my-sandbox-id",
 * );
 * await sandbox.initialize();
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant with sandbox access.",
 *     backend: sandbox,
 *   });
 *
 *   const result = await agent.invoke({
 *     messages: [new HumanMessage("Create a hello world app")],
 *   });
 * } finally {
 *   await sandbox.close();
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Full lifecycle: create a sandbox from a template
 * const sandbox = await K8sAgentSandbox.create({
 *   template: "python-sandbox-template",
 *   namespace: "default",
 *   deleteOnClose: true,
 * });
 *
 * const result = await sandbox.execute("python --version");
 * console.log(result.output);
 *
 * await sandbox.close(); // deletes the sandbox
 * ```
 *
 * @packageDocumentation
 */

export { K8sAgentSandbox } from "./sandbox.js";

export type {
  K8sAgentSandboxOptions,
  K8sAgentSandboxCreateOptions,
  K8sDirectConnectionConfig,
  K8sGatewayConnectionConfig,
  K8sTunnelConnectionConfig,
  K8sConnectionConfig,
  K8sAgentSandboxErrorCode,
} from "./types.js";

export { K8sAgentSandboxError } from "./types.js";
