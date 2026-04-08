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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { K8sAgentSandbox } from "./sandbox.js";
import { K8sAgentSandboxError } from "./types.js";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockExecute = vi.fn();
const mockDownload = vi.fn();
const mockHealthzResult = vi.fn();
const mockHealthCheck = vi.fn();
const mockClose = vi.fn();

vi.mock("./http-client.js", () => ({
  SandboxRouterClient: class {
    constructor() {}
    execute = mockExecute;
    download = mockDownload;
    healthzResult = mockHealthzResult;
    healthCheck = mockHealthCheck;
    close = mockClose;
  },
}));

vi.mock("./connection.js", () => ({
  createConnectionStrategy: () => ({
    connect: vi.fn().mockResolvedValue("http://localhost:8080"),
    close: vi.fn().mockResolvedValue(undefined),
    verifyConnection: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Module-scope K8sClient mocks so they're shared across instances and can
// be asserted against from tests that exercise static factory methods like
// deleteAll(), which constructs its own K8sClient internally.
const mockCreateSandboxClaim = vi.fn().mockResolvedValue(undefined);
const mockResolveSandboxName = vi.fn().mockResolvedValue("sandbox-abc123");
const mockWaitForSandboxReady = vi.fn().mockResolvedValue(undefined);
const mockDeleteSandboxClaim = vi.fn().mockResolvedValue(undefined);
const mockGetSandbox = vi.fn().mockResolvedValue({});
const mockListSandboxClaims = vi.fn().mockResolvedValue([]);
const mockWaitForGatewayIp = vi.fn().mockResolvedValue("1.2.3.4");

vi.mock("./k8s-client.js", () => ({
  K8sClient: class {
    createSandboxClaim = mockCreateSandboxClaim;
    resolveSandboxName = mockResolveSandboxName;
    waitForSandboxReady = mockWaitForSandboxReady;
    deleteSandboxClaim = mockDeleteSandboxClaim;
    getSandbox = mockGetSandbox;
    listSandboxClaims = mockListSandboxClaims;
    waitForGatewayIp = mockWaitForGatewayIp;
  },
}));

describe("K8sAgentSandbox", () => {
  let sandbox: K8sAgentSandbox;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHealthzResult.mockResolvedValue({ ok: true });
    mockHealthCheck.mockResolvedValue(true);
    mockClose.mockResolvedValue(undefined);

    sandbox = new K8sAgentSandbox({
      connectionConfig: { type: "direct", baseUrl: "http://localhost:8080" },
      sandboxId: "test-sandbox-123",
      namespace: "default",
    });
  });

  describe("constructor", () => {
    it("should create instance with correct id", () => {
      expect(sandbox.id).toBe("test-sandbox-123");
    });

    it("should not be running before initialization", () => {
      expect(sandbox.isRunning).toBe(false);
    });

    it("should default namespace to 'default'", () => {
      expect(sandbox.namespace).toBe("default");
    });

    it("should have null claimName by default", () => {
      expect(sandbox.claimName).toBeNull();
    });

    it("should store claimName if provided", () => {
      const sb = new K8sAgentSandbox({
        connectionConfig: { type: "direct", baseUrl: "http://localhost:8080" },
        sandboxId: "sb-1",
        claimName: "claim-1",
      });
      expect(sb.claimName).toBe("claim-1");
    });
  });

  describe("initialize", () => {
    it("should set isRunning to true", async () => {
      await sandbox.initialize();
      expect(sandbox.isRunning).toBe(true);
    });

    it("should throw if already initialized", async () => {
      await sandbox.initialize();
      await expect(sandbox.initialize()).rejects.toThrow(
        "already initialized",
      );
    });

    it("should throw if sandbox is not reachable", async () => {
      mockHealthCheck.mockResolvedValue(false);
      await expect(sandbox.initialize()).rejects.toThrow("health check returned non-200");
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it("should wrap command in sh -c", async () => {
      mockExecute.mockResolvedValue({
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
      });

      await sandbox.execute("echo hello");

      expect(mockExecute).toHaveBeenCalledWith(
        "sh -c 'echo hello'",
        expect.any(AbortSignal),
      );
    });

    it("should combine stdout and stderr", async () => {
      mockExecute.mockResolvedValue({
        stdout: "out",
        stderr: "err",
        exitCode: 0,
      });

      const result = await sandbox.execute("test");
      expect(result.output).toBe("out\nerr");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("should return stdout only when no stderr", async () => {
      mockExecute.mockResolvedValue({
        stdout: "output",
        stderr: "",
        exitCode: 0,
      });

      const result = await sandbox.execute("test");
      expect(result.output).toBe("output");
    });

    it("should properly escape single quotes in commands", async () => {
      mockExecute.mockResolvedValue({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      });

      await sandbox.execute("echo it's a test");

      const call = mockExecute.mock.calls[0]![0] as string;
      expect(call).toBe("sh -c 'echo it'\\''s a test'");
    });

    it("should pass through exit codes", async () => {
      mockExecute.mockResolvedValue({
        stdout: "",
        stderr: "not found",
        exitCode: 127,
      });

      const result = await sandbox.execute("nonexistent");
      expect(result.exitCode).toBe(127);
    });

    it("should throw COMMAND_TIMEOUT when the abort signal fires", async () => {
      const timeoutErr = new Error("operation aborted");
      timeoutErr.name = "TimeoutError";
      mockExecute.mockRejectedValue(timeoutErr);

      await expect(sandbox.execute("sleep 9999")).rejects.toMatchObject({
        code: "COMMAND_TIMEOUT",
      });
    });

    it("should throw COMMAND_FAILED for non-timeout errors", async () => {
      mockExecute.mockRejectedValue(new Error("network unreachable"));

      await expect(sandbox.execute("ls")).rejects.toMatchObject({
        code: "COMMAND_FAILED",
      });
    });
  });

  describe("uploadFiles", () => {
    beforeEach(async () => {
      await sandbox.initialize();
      mockExecute.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    });

    it("should upload file via base64 execute", async () => {
      const content = new TextEncoder().encode("hello world");
      const responses = await sandbox.uploadFiles([["/app/test.txt", content]]);

      expect(responses).toHaveLength(1);
      expect(responses[0]!.path).toBe("/app/test.txt");
      expect(responses[0]!.error).toBeNull();

      // Verify execute was called with mkdir + base64 command
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("sh -c ");
      expect(cmd).toContain("mkdir -p");
      expect(cmd).toContain("base64 -d");
    });

    it("should handle multiple files", async () => {
      const enc = new TextEncoder();
      const responses = await sandbox.uploadFiles([
        ["/app/a.txt", enc.encode("aaa")],
        ["/app/b.txt", enc.encode("bbb")],
      ]);

      expect(responses).toHaveLength(2);
      expect(responses.every((r) => r.error === null)).toBe(true);
    });

    it("should return permission_denied on non-zero exit", async () => {
      mockExecute.mockResolvedValue({
        stdout: "",
        stderr: "permission denied",
        exitCode: 1,
      });

      const content = new TextEncoder().encode("test");
      const responses = await sandbox.uploadFiles([["/root/test.txt", content]]);

      expect(responses[0]!.error).toBe("permission_denied");
    });

    it("should virtualize relative paths against rootDir", async () => {
      const content = new TextEncoder().encode("data");
      const responses = await sandbox.uploadFiles([["test.txt", content]]);

      expect(responses[0]!.error).toBeNull();
      // The wrapped cmd is `sh -c 'mkdir -p '\''/app'\'' && ... > '\''/app/test.txt'\'''`
      // — single quotes are doubly-escaped through the sh -c wrapping
      // and the inner shellQuote. Match on the path strings directly,
      // which appear unmodified (the outer escape only affects the
      // surrounding single quotes, not the path content).
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("mkdir -p");
      expect(cmd).toContain("/app/test.txt");
    });

    it("should not double-prefix paths already under rootDir", async () => {
      const content = new TextEncoder().encode("data");
      const responses = await sandbox.uploadFiles([["/app/already.txt", content]]);

      expect(responses[0]!.error).toBeNull();
      // /app/already.txt should NOT become /app/app/already.txt
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("/app/already.txt");
      expect(cmd).not.toContain("/app/app/");
    });

    it("should virtualize absolute paths outside rootDir", async () => {
      const content = new TextEncoder().encode("data");
      const responses = await sandbox.uploadFiles([["/etc/foo.conf", content]]);

      expect(responses[0]!.error).toBeNull();
      // /etc/foo.conf should be rewritten as /app/etc/foo.conf so the
      // upload/download round-trip is symmetric.
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("/app/etc/foo.conf");
    });
  });

  describe("downloadFiles", () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it("should download file via HTTP", async () => {
      const content = new TextEncoder().encode("file content");
      mockDownload.mockResolvedValue(content);

      const responses = await sandbox.downloadFiles(["/app/test.txt"]);

      expect(responses).toHaveLength(1);
      // The caller-supplied path is preserved on the response so the
      // caller can correlate inputs with outputs.
      expect(responses[0]!.path).toBe("/app/test.txt");
      expect(responses[0]!.content).toEqual(content);
      expect(responses[0]!.error).toBeNull();

      // /app/test.txt is already under rootDir; toRouterDownloadPath
      // strips the /app/ prefix for the runtime endpoint.
      expect(mockDownload).toHaveBeenCalledWith("test.txt");
    });

    it("should strip /app/ prefix from paths already under rootDir", async () => {
      mockDownload.mockResolvedValue(new Uint8Array());

      await sandbox.downloadFiles(["/app/nested/dir/file.py"]);

      expect(mockDownload).toHaveBeenCalledWith("nested/dir/file.py");
    });

    it("should virtualize absolute paths outside rootDir", async () => {
      mockDownload.mockResolvedValue(new Uint8Array());

      // /other/path.txt is virtualized to /app/other/path.txt, then
      // the /app/ prefix is stripped for the router.
      await sandbox.downloadFiles(["/other/path.txt"]);

      expect(mockDownload).toHaveBeenCalledWith("other/path.txt");
    });

    it("should handle file not found", async () => {
      mockDownload.mockRejectedValue(
        new K8sAgentSandboxError(
          "File not found: missing.txt",
          "FILE_OPERATION_FAILED",
          undefined,
          404,
        ),
      );

      const responses = await sandbox.downloadFiles(["/app/missing.txt"]);

      expect(responses[0]!.error).toBe("file_not_found");
      expect(responses[0]!.content).toBeNull();
    });

    it("should handle access denied via httpStatus", async () => {
      // The new error mapping uses err.httpStatus instead of
      // string-matching the message — pin that contract.
      mockDownload.mockRejectedValue(
        new K8sAgentSandboxError(
          "Access denied: /etc/shadow",
          "FILE_OPERATION_FAILED",
          undefined,
          403,
        ),
      );

      const responses = await sandbox.downloadFiles(["/etc/shadow"]);

      expect(responses[0]!.error).toBe("permission_denied");
    });

    it("should handle multiple files with mixed results", async () => {
      mockDownload
        .mockResolvedValueOnce(new TextEncoder().encode("ok"))
        .mockRejectedValueOnce(
          new K8sAgentSandboxError(
            "File not found",
            "FILE_OPERATION_FAILED",
            undefined,
            404,
          ),
        );

      const responses = await sandbox.downloadFiles([
        "/app/exists.txt",
        "/app/missing.txt",
      ]);

      expect(responses[0]!.error).toBeNull();
      expect(responses[1]!.error).toBe("file_not_found");
    });
  });

  describe("close", () => {
    it("should set isRunning to false", async () => {
      await sandbox.initialize();
      await sandbox.close();
      expect(sandbox.isRunning).toBe(false);
    });

    it("should close the HTTP client", async () => {
      await sandbox.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("healthz", () => {
    it("should return ok=true when sandbox is healthy", async () => {
      mockHealthzResult.mockResolvedValue({ ok: true });
      const result = await sandbox.healthz();
      expect(result.ok).toBe(true);
    });

    it("should return categorized failure when sandbox is unreachable", async () => {
      const err = new K8sAgentSandboxError(
        "ECONNREFUSED",
        "CONNECTION_FAILED",
      );
      mockHealthzResult.mockResolvedValue({
        ok: false,
        reason: "unreachable",
        error: err,
      });
      const result = await sandbox.healthz();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unreachable");
        expect(result.error).toBe(err);
      }
    });
  });

  describe("fromUrl", () => {
    it("should create a sandbox with direct connection", () => {
      const sb = K8sAgentSandbox.fromUrl(
        "http://localhost:8080",
        "sb-123",
        { namespace: "test-ns" },
      );

      expect(sb.id).toBe("sb-123");
      expect(sb.namespace).toBe("test-ns");
      expect(sb.isRunning).toBe(false);
    });

    it("should use default namespace", () => {
      const sb = K8sAgentSandbox.fromUrl("http://localhost:8080", "sb-123");
      expect(sb.namespace).toBe("default");
    });
  });

  describe("create", () => {
    it("should provision and initialize a sandbox", async () => {
      const sb = await K8sAgentSandbox.create({
        template: "python-sandbox-template",
        namespace: "test-ns",
      });

      expect(sb.id).toBe("sandbox-abc123");
      expect(sb.namespace).toBe("test-ns");
      expect(sb.isRunning).toBe(true);
      expect(sb.claimName).toMatch(/^sandbox-claim-/);

      await sb.close();
    });

    it("should default deleteOnClose to true", async () => {
      const sb = await K8sAgentSandbox.create({
        template: "python-sandbox-template",
      });

      // The sandbox should be configured to delete on close
      // We can verify by closing and checking that deleteSandboxClaim was called
      await sb.close();
      // Note: The mock K8sClient's deleteSandboxClaim was called
    });

    it("should upload string and Uint8Array initialFiles after init", async () => {
      mockExecute.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      const binary = new Uint8Array([0x01, 0x02, 0x03, 0xff]);

      const sb = await K8sAgentSandbox.create({
        template: "python-sandbox-template",
        initialFiles: {
          "config.json": '{"k":1}',
          "/app/data.bin": binary,
        },
      });

      // Two execute() calls are issued — one per file. Both commands
      // should reference the virtualized absolute path: "config.json"
      // becomes "/app/config.json", and "/app/data.bin" stays as
      // "/app/data.bin" (already under rootDir so no double-prefix).
      // Match on path substrings rather than the full quoted form
      // because sh -c wrapping doubly-escapes the inner single quotes.
      const commands = mockExecute.mock.calls.map((c) => c[0] as string);
      expect(commands.length).toBe(2);
      expect(
        commands.some(
          (cmd) =>
            cmd.includes("/app/config.json") && cmd.includes("base64 -d"),
        ),
      ).toBe(true);
      expect(
        commands.some(
          (cmd) =>
            cmd.includes("/app/data.bin") && cmd.includes("base64 -d"),
        ),
      ).toBe(true);

      await sb.close();
    });

    it("should throw SANDBOX_CREATION_FAILED and tear down tunnel + claim on initialFiles upload failure", async () => {
      // First execute() succeeds, second rejects → second file's
      // upload returns error: "invalid_path" (per the settled-map in
      // K8sAgentSandbox.uploadFiles) and create() should throw.
      mockExecute
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
        .mockRejectedValueOnce(new Error("upload failed"));

      mockDeleteSandboxClaim.mockClear();
      mockClose.mockClear();

      await expect(
        K8sAgentSandbox.create({
          template: "python-sandbox-template",
          initialFiles: {
            "first.txt": "ok",
            "second.txt": "will fail",
          },
        }),
      ).rejects.toMatchObject({
        code: "SANDBOX_CREATION_FAILED",
      });

      // create() should have called sandbox.close() to tear down the
      // HTTP client / tunnel subprocess before propagating the error.
      expect(mockClose).toHaveBeenCalled();

      // The claim should have been deleted exactly once. sandbox.close()
      // handles the delete when deleteOnClose is true (the default), so
      // the outer cleanup 404s and is silently swallowed.
      expect(mockDeleteSandboxClaim).toHaveBeenCalled();
      const claimNames = mockDeleteSandboxClaim.mock.calls.map((c) => c[0]);
      expect(claimNames.every((n) => (n as string).match(/^sandbox-claim-/))).toBe(true);
    });
  });

  describe("fromExisting", () => {
    it("should attach to an existing claim", async () => {
      const sb = await K8sAgentSandbox.fromExisting("claim-abc", {
        connectionConfig: { type: "direct", baseUrl: "http://localhost:8080" },
        namespace: "test-ns",
      });

      expect(sb.id).toBe("sandbox-abc123");
      expect(sb.claimName).toBe("claim-abc");
      expect(sb.isRunning).toBe(true);

      await sb.close();
    });
  });

  describe("deleteAll", () => {
    it("should forward labels to listSandboxClaims for filtering", async () => {
      mockListSandboxClaims.mockResolvedValueOnce([]);

      await K8sAgentSandbox.deleteAll(
        { purpose: "integration-test", package: "langchain-agent-sandbox" },
        "test-ns",
      );

      expect(mockListSandboxClaims).toHaveBeenCalledWith("test-ns", {
        purpose: "integration-test",
        package: "langchain-agent-sandbox",
      });
    });

    it("should refuse empty labels without confirmDeleteAll", async () => {
      await expect(K8sAgentSandbox.deleteAll({}, "test-ns")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("deleteAll refused"),
      });
      expect(mockListSandboxClaims).not.toHaveBeenCalled();
    });

    it("should allow empty labels when confirmDeleteAll is true", async () => {
      mockListSandboxClaims.mockResolvedValueOnce([]);

      await K8sAgentSandbox.deleteAll({}, "test-ns", { confirmDeleteAll: true });

      expect(mockListSandboxClaims).toHaveBeenCalledWith("test-ns", {});
    });

    it("should default to the 'default' namespace", async () => {
      mockListSandboxClaims.mockResolvedValueOnce([]);

      await K8sAgentSandbox.deleteAll({ purpose: "test" });

      expect(mockListSandboxClaims).toHaveBeenCalledWith("default", {
        purpose: "test",
      });
    });

    it("should delete every claim returned by the filtered list", async () => {
      mockListSandboxClaims.mockResolvedValueOnce(["claim-a", "claim-b"]);

      await K8sAgentSandbox.deleteAll({ purpose: "test" }, "ns");

      expect(mockDeleteSandboxClaim).toHaveBeenCalledWith("claim-a", "ns");
      expect(mockDeleteSandboxClaim).toHaveBeenCalledWith("claim-b", "ns");
      expect(mockDeleteSandboxClaim).toHaveBeenCalledTimes(2);
    });
  });
});
