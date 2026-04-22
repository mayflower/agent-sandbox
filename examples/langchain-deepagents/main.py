# Copyright 2026 The Kubernetes Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
LangChain DeepAgents example with agent-sandbox backend.

This example demonstrates how to use DeepAgents with Kubernetes-native
sandboxes for secure, isolated code execution.

Usage:
    # Interactive mode (tunnel, default)
    python main.py

    # Single query
    python main.py --query "Create a hello world script"

    # With gateway (production)
    python main.py --gateway external-http-gateway

    # With direct URL (in-cluster)
    python main.py --api-url http://sandbox-router:8080

    # With session reattach (multi-turn)
    python main.py --session-id my-thread-123
"""

import argparse
import os
import sys

from deepagents import create_deep_agent
from k8s_agent_sandbox import SandboxClient
from k8s_agent_sandbox.models import (
    SandboxDirectConnectionConfig,
    SandboxGatewayConnectionConfig,
    SandboxLocalTunnelConnectionConfig,
)
from langchain_agent_sandbox import AgentSandboxBackend


def get_model():
    """Get the chat model based on available API keys."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model="claude-sonnet-4-20250514")

    if os.environ.get("OPENAI_API_KEY"):
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(model="gpt-4o")

    if os.environ.get("GOOGLE_API_KEY"):
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(model="gemini-1.5-pro")

    print("Error: No API key found. Set one of:")
    print("  - ANTHROPIC_API_KEY")
    print("  - OPENAI_API_KEY")
    print("  - GOOGLE_API_KEY")
    sys.exit(1)


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run a DeepAgent with agent-sandbox backend"
    )
    parser.add_argument(
        "--query",
        "-q",
        type=str,
        help="Single query to run (omit for interactive mode)",
    )
    parser.add_argument(
        "--template",
        "-t",
        type=str,
        default=os.environ.get("LANGCHAIN_SANDBOX_TEMPLATE", "python-deepagent"),
        help="SandboxTemplate name (default: python-deepagent)",
    )
    parser.add_argument(
        "--namespace",
        "-n",
        type=str,
        default=os.environ.get("LANGCHAIN_NAMESPACE", "default"),
        help="Kubernetes namespace (default: default)",
    )
    parser.add_argument(
        "--gateway",
        type=str,
        default=None,
        help="Gateway name for production mode",
    )
    parser.add_argument(
        "--gateway-namespace",
        type=str,
        default="default",
        help="Gateway namespace (default: default)",
    )
    parser.add_argument(
        "--api-url",
        type=str,
        default=os.environ.get("LANGCHAIN_API_URL"),
        help="Direct API URL (bypasses gateway discovery)",
    )
    parser.add_argument(
        "--root-dir",
        type=str,
        default=os.environ.get("LANGCHAIN_ROOT_DIR", "/app"),
        help="Virtual filesystem root in sandbox (default: /app)",
    )
    parser.add_argument(
        "--session-id",
        type=str,
        default=None,
        help="Session ID for sandbox reattach (multi-turn agents)",
    )
    parser.add_argument(
        "--skills",
        type=str,
        nargs="*",
        default=[".deepagents/skills"],
        help="Skill directories to load (default: .deepagents/skills)",
    )
    return parser.parse_args()


def run_interactive(agent):
    """Run the agent in interactive mode."""
    print("\nDeepAgent with Sandbox Backend")
    print("=" * 40)
    print("Type your queries below. Use 'quit' or 'exit' to stop.\n")

    while True:
        try:
            query = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye!")
            break

        if not query:
            continue

        if query.lower() in ("quit", "exit", "q"):
            print("Goodbye!")
            break

        try:
            result = agent.invoke({"messages": [("user", query)]})
            # Extract the last AI message
            messages = result.get("messages", [])
            for msg in reversed(messages):
                if hasattr(msg, "content") and msg.type == "ai":
                    print(f"\nAgent: {msg.content}\n")
                    break
        except Exception as e:
            print(f"\nError: {e}\n")


def run_single_query(agent, query: str):
    """Run a single query and print the result."""
    print(f"Query: {query}\n")

    result = agent.invoke({"messages": [("user", query)]})

    # Extract the last AI message
    messages = result.get("messages", [])
    for msg in reversed(messages):
        if hasattr(msg, "content") and msg.type == "ai":
            print(f"Agent: {msg.content}")
            break


def main():
    """Main entry point."""
    args = parse_args()

    model = get_model()
    print(f"Connecting to sandbox (template: {args.template})...")

    # Build SandboxClient with appropriate connection mode
    if args.api_url:
        connection_config = SandboxDirectConnectionConfig(api_url=args.api_url)
        print(f"Using direct connection: {args.api_url}")
    elif args.gateway:
        connection_config = SandboxGatewayConnectionConfig(
            gateway_name=args.gateway,
            gateway_namespace=args.gateway_namespace,
        )
        print(f"Using gateway: {args.gateway}")
    else:
        connection_config = SandboxLocalTunnelConnectionConfig()
        print("Using tunnel mode (kubectl port-forward)")

    client = SandboxClient(connection_config=connection_config)

    with AgentSandboxBackend.from_template(
        client,
        template_name=args.template,
        namespace=args.namespace,
        root_dir=args.root_dir,
        session_id=args.session_id,
    ) as backend:
        print(f"Sandbox ready (id: {backend.id})\n")

        agent = create_deep_agent(
            model=model,
            backend=backend,
            skills=args.skills,
        )

        if args.query:
            run_single_query(agent, args.query)
        else:
            run_interactive(agent)


if __name__ == "__main__":
    main()
