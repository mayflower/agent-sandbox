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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SandboxRouterClient } from "./http-client.js";
import { K8sAgentSandboxError } from "./types.js";
import type { ConnectionStrategy } from "./connection.js";

// ---------------------------------------------------------------------------
// Mock ConnectionStrategy
// ---------------------------------------------------------------------------

function createMockStrategy(baseUrl = "http://localhost:8080"): ConnectionStrategy {
  return {
    connect: vi.fn().mockResolvedValue(baseUrl),
    close: vi.fn().mockResolvedValue(undefined),
    verifyConnection: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetchResponse(
  status: number,
  body: unknown,
  contentType = "application/json",
): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: () => {
      if (body instanceof Uint8Array) {
        return Promise.resolve(body.buffer);
      }
      const encoder = new TextEncoder();
      return Promise.resolve(encoder.encode(String(body)).buffer);
    },
    headers: new Headers({ "content-type": contentType }),
  } as unknown as Response);
}

describe("SandboxRouterClient", () => {
  let strategy: ConnectionStrategy;
  let client: SandboxRouterClient;

  beforeEach(() => {
    strategy = createMockStrategy();
    client = new SandboxRouterClient(strategy, "sandbox-123", "test-ns", 8888);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("execute", () => {
    it("should send correct request with sandbox headers", async () => {
      mockFetchResponse(200, {
        stdout: "hello\n",
        stderr: "",
        exit_code: 0,
      });

      const result = await client.execute("echo hello");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8080/execute",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ command: "echo hello" }),
          headers: expect.objectContaining({
            "X-Sandbox-ID": "sandbox-123",
            "X-Sandbox-Namespace": "test-ns",
            "X-Sandbox-Port": "8888",
            "Content-Type": "application/json",
          }),
        }),
      );

      expect(result).toEqual({
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
      });
    });

    it("should handle non-zero exit codes", async () => {
      mockFetchResponse(200, {
        stdout: "",
        stderr: "command not found",
        exit_code: 127,
      });

      const result = await client.execute("nonexistent");
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toBe("command not found");
    });

    it("should throw on HTTP error", async () => {
      mockFetchResponse(500, "Internal Server Error");

      await expect(client.execute("echo hello")).rejects.toThrow(
        K8sAgentSandboxError,
      );
    });

    it("should throw on connection failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(client.execute("echo hello")).rejects.toThrow(
        "Failed to connect",
      );
    });

    it("should propagate TimeoutError from AbortSignal without wrapping", async () => {
      const timeoutErr = new Error("The operation was aborted due to timeout");
      timeoutErr.name = "TimeoutError";
      globalThis.fetch = vi.fn().mockRejectedValue(timeoutErr);

      await expect(
        client.execute("sleep 9999", AbortSignal.timeout(1)),
      ).rejects.toMatchObject({
        name: "TimeoutError",
        message: "The operation was aborted due to timeout",
      });
    });

    it("should propagate AbortError from manual abort without wrapping", async () => {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      globalThis.fetch = vi.fn().mockRejectedValue(abortErr);

      const controller = new AbortController();
      controller.abort();
      await expect(
        client.execute("sleep 9999", controller.signal),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
    });

    it("should verify connection before each request", async () => {
      mockFetchResponse(200, { stdout: "", stderr: "", exit_code: 0 });

      await client.execute("test");

      expect(strategy.verifyConnection).toHaveBeenCalled();
      expect(strategy.connect).toHaveBeenCalled();
    });
  });

  describe("download", () => {
    it("should download file as Uint8Array", async () => {
      const content = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      mockFetchResponse(200, content, "application/octet-stream");

      const result = await client.download("src/main.py");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8080/download/src%2Fmain.py",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "X-Sandbox-ID": "sandbox-123",
          }),
        }),
      );

      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("should throw on 404", async () => {
      mockFetchResponse(404, { message: "File not found" });

      await expect(client.download("missing.txt")).rejects.toThrow(
        "File not found",
      );
    });

    it("should throw on 403", async () => {
      mockFetchResponse(403, { message: "Access denied" });

      await expect(client.download("../etc/passwd")).rejects.toThrow(
        "Access denied",
      );
    });

    it("should URL-encode special characters in path", async () => {
      mockFetchResponse(200, new Uint8Array([]), "application/octet-stream");

      await client.download("path/to/my file.txt");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("path%2Fto%2Fmy%20file.txt"),
        expect.anything(),
      );
    });
  });

  describe("healthzResult", () => {
    it("should return ok=true on 200", async () => {
      mockFetchResponse(200, { status: "ok" });
      const result = await client.healthzResult();
      expect(result.ok).toBe(true);
    });

    it("should categorize network failure as unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await client.healthzResult();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unreachable");
        expect(result.error.code).toBe("CONNECTION_FAILED");
      }
    });

    it("should categorize non-200 as http-error and preserve status", async () => {
      mockFetchResponse(503, "Service Unavailable");
      const result = await client.healthzResult();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // healthCheck() now throws a typed HTTP_ERROR with the HTTP
        // status + body snippet; healthzResult() catches and maps
        // it to reason: "http-error" via the exhaustive switch.
        expect(result.reason).toBe("http-error");
        expect(result.error.code).toBe("HTTP_ERROR");
        expect(result.error.httpStatus).toBe(503);
      }
    });

    it("should categorize an error code outside the explicit mapping as 'unknown'", async () => {
      // Drive the "unknown" branch of the exhaustive switch by
      // having the strategy reject with a typed error whose code
      // is NOT in {CONNECTION_FAILED, TUNNEL_FAILED,
      // SANDBOX_NOT_REACHABLE, COMMAND_TIMEOUT, HTTP_ERROR}. This
      // pins the fallback and forces anyone adding a new error
      // code to think about the healthz mapping.
      const badStrategy = {
        connect: vi.fn().mockResolvedValue("http://x:1"),
        close: vi.fn().mockResolvedValue(undefined),
        verifyConnection: vi
          .fn()
          .mockRejectedValue(
            new K8sAgentSandboxError(
              "bad call",
              "INVALID_ARGUMENT",
            ),
          ),
      };
      const weirdClient = new SandboxRouterClient(
        badStrategy as unknown as ConnectionStrategy,
        "sb-1",
        "default",
      );
      const result = await weirdClient.healthzResult();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unknown");
        expect(result.error.code).toBe("INVALID_ARGUMENT");
      }
    });
  });

  describe("close", () => {
    it("should delegate to strategy", async () => {
      await client.close();
      expect(strategy.close).toHaveBeenCalled();
    });
  });
});
