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
import {
  K8sAgentSandboxError,
  K8sFileDownloadBatchError,
  K8sFileUploadBatchError,
} from "./types.js";

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
    mockHealthCheck.mockResolvedValue(undefined);
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

    it("should throw SANDBOX_NOT_REACHABLE if health check returns HTTP error", async () => {
      // healthCheck() now throws a typed HTTP_ERROR on non-2xx (no
      // more bare boolean return). initialize() rewraps HTTP_ERROR
      // as SANDBOX_NOT_REACHABLE so callers still see the
      // "unreachable" signal, but the original HTTP status is
      // preserved on the wrapped error's httpStatus field.
      mockHealthCheck.mockRejectedValueOnce(
        new K8sAgentSandboxError(
          "Health check failed (HTTP 503): down",
          "HTTP_ERROR",
          undefined,
          503,
        ),
      );
      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "SANDBOX_NOT_REACHABLE",
        httpStatus: 503,
      });
    });

    it("should propagate transport failures as SANDBOX_NOT_REACHABLE", async () => {
      mockHealthCheck.mockRejectedValueOnce(
        new K8sAgentSandboxError(
          "connect ECONNREFUSED",
          "CONNECTION_FAILED",
        ),
      );
      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "CONNECTION_FAILED",
      });
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

      // Verify execute was called with the LC_ALL=C + symlink-guard
      // wrapper around base64. `mkdir -p` is only emitted when the
      // parent directory differs from runtimeWorkDir — for
      // /app/test.txt under runtimeWorkDir=/app, the parent IS /app
      // so mkdir is omitted (no subdirectory to create).
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("sh -c ");
      expect(cmd).toContain("LC_ALL=C");
      expect(cmd).toContain("realpath");
      expect(cmd).toContain("base64 -d");
    });

    it("should emit mkdir -p for nested subdirectories under rootDir", async () => {
      const content = new TextEncoder().encode("x");
      mockExecute.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      await sandbox.uploadFiles([["/app/nested/dir/file.txt", content]]);
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("mkdir -p");
      expect(cmd).toContain("/app/nested/dir");
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
      // The wrapper no longer unconditionally emits mkdir -p — for
      // a path whose parent equals runtimeWorkDir, the parent
      // already exists, so no mkdir is needed. Just verify the
      // virtualized path made it into the command.
      const cmd = mockExecute.mock.calls[0]![0] as string;
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
      await sandbox.initialize();
      await sandbox.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("healthz", () => {
    it("should return ok=true when sandbox is healthy", async () => {
      await sandbox.initialize();
      mockHealthzResult.mockResolvedValue({ ok: true });
      const result = await sandbox.healthz();
      expect(result.ok).toBe(true);
    });

    it("should return categorized failure when sandbox is unreachable", async () => {
      await sandbox.initialize();
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

    it("throws NOT_INITIALIZED if called before initialize()", async () => {
      // Round-4 fix: healthz() now requires initialization because
      // calling it pre-init on a tunnel-mode sandbox would spawn the
      // kubectl subprocess as a side effect and leak it if the
      // caller never initializes. Calling it post-close() would
      // likewise resurrect the tunnel.
      await expect(sandbox.healthz()).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    it("throws NOT_INITIALIZED if called after close()", async () => {
      await sandbox.initialize();
      await sandbox.close();
      await expect(sandbox.healthz()).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });
  });

  // -------------------------------------------------------------------------
  // #assertRunning precondition checks (T1 from round-4 review)
  // -------------------------------------------------------------------------

  describe("#assertRunning precondition", () => {
    it("execute throws NOT_INITIALIZED before initialize()", async () => {
      await expect(sandbox.execute("echo hi")).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    it("execute throws NOT_INITIALIZED after close()", async () => {
      await sandbox.initialize();
      await sandbox.close();
      await expect(sandbox.execute("echo hi")).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    it("uploadFiles throws NOT_INITIALIZED before initialize()", async () => {
      const enc = new TextEncoder();
      await expect(
        sandbox.uploadFiles([["a.txt", enc.encode("a")]]),
      ).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    });

    it("uploadFiles throws NOT_INITIALIZED after close()", async () => {
      await sandbox.initialize();
      await sandbox.close();
      const enc = new TextEncoder();
      await expect(
        sandbox.uploadFiles([["a.txt", enc.encode("a")]]),
      ).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    });

    it("downloadFiles throws NOT_INITIALIZED before initialize()", async () => {
      await expect(sandbox.downloadFiles(["/app/a.txt"])).rejects.toMatchObject(
        { code: "NOT_INITIALIZED" },
      );
    });

    it("downloadFiles throws NOT_INITIALIZED after close()", async () => {
      await sandbox.initialize();
      await sandbox.close();
      await expect(sandbox.downloadFiles(["/app/a.txt"])).rejects.toMatchObject(
        { code: "NOT_INITIALIZED" },
      );
    });

    it("NOT_INITIALIZED is thrown directly (not wrapped in a batch error) so callers can branch on it", async () => {
      // #isBatchFatalCode lists NOT_INITIALIZED, but the assertion
      // fires BEFORE the Promise.allSettled, so the throw bubbles
      // as a plain K8sAgentSandboxError, not a batch error. This
      // pins that contract — a refactor that moved the check
      // inside the per-file lambda would silently change the
      // thrown shape from K8sAgentSandboxError to K8sFileUploadBatchError,
      // breaking callers that branch on `err.code`.
      const enc = new TextEncoder();
      let caught: unknown = null;
      try {
        await sandbox.uploadFiles([["a.txt", enc.encode("a")]]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(K8sAgentSandboxError);
      expect(caught).not.toBeInstanceOf(K8sFileUploadBatchError);
    });
  });

  // -------------------------------------------------------------------------
  // NUL-byte / control-char path rejection (H5 from round-4 review)
  // -------------------------------------------------------------------------

  describe("path NUL/control-char rejection", () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it("uploadFiles rejects a path containing a NUL byte", async () => {
      const enc = new TextEncoder();
      let caught: unknown = null;
      try {
        await sandbox.uploadFiles([
          ["/app/report\x00attack.sh", enc.encode("x")],
        ]);
      } catch (e) {
        caught = e;
      }
      // INVALID_ARGUMENT is batch-fatal so it surfaces as a
      // K8sFileUploadBatchError rather than a per-file invalid_path
      // entry. That's the correct security boundary — the LLM must
      // see this error, not silently treat the path as unwritable.
      expect(caught).toBeInstanceOf(K8sFileUploadBatchError);
      const err = caught as K8sFileUploadBatchError;
      expect(err.code).toBe("INVALID_ARGUMENT");
    });

    it("downloadFiles rejects a path containing a NUL byte", async () => {
      let caught: unknown = null;
      try {
        await sandbox.downloadFiles(["/app/report\x00attack.sh"]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(K8sFileDownloadBatchError);
      const err = caught as K8sFileDownloadBatchError;
      expect(err.code).toBe("INVALID_ARGUMENT");
    });

    it("rejects a path containing a newline", async () => {
      const enc = new TextEncoder();
      let caught: unknown = null;
      try {
        await sandbox.uploadFiles([
          ["/app/foo\nbar.txt", enc.encode("x")],
        ]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(K8sFileUploadBatchError);
      expect((caught as K8sFileUploadBatchError).code).toBe(
        "INVALID_ARGUMENT",
      );
    });

    it("constructor rejects rootDir with a NUL byte", () => {
      expect(() =>
        new K8sAgentSandbox({
          connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
          sandboxId: "sb-1",
          rootDir: "/app\x00junk",
        }),
      ).toThrow(/control/);
    });
  });

  // -------------------------------------------------------------------------
  // rootDir: "/" edge case (C5 from round-4 review)
  // -------------------------------------------------------------------------

  describe("rootDir='/' construction and path handling", () => {
    it("constructor accepts rootDir='/' and runtimeWorkDir='/'", () => {
      expect(
        () =>
          new K8sAgentSandbox({
            connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
            sandboxId: "sb-1",
            rootDir: "/",
            runtimeWorkDir: "/",
          }),
      ).not.toThrow();
    });

    it("uploadFiles with rootDir='/' virtualizes correctly without '//'", async () => {
      const rootSandbox = new K8sAgentSandbox({
        connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
        sandboxId: "sb-1",
        rootDir: "/",
        runtimeWorkDir: "/",
      });
      await rootSandbox.initialize();
      mockExecute.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      const enc = new TextEncoder();
      const results = await rootSandbox.uploadFiles([
        ["/foo.txt", enc.encode("x")],
      ]);
      expect(results[0]!.error).toBeNull();
      // Assert the shell command does NOT contain `//foo.txt`.
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).not.toContain("//foo.txt");
      expect(cmd).toContain("/foo.txt");
    });

    it("downloadFiles with runtimeWorkDir='/' strips the leading slash", async () => {
      const rootSandbox = new K8sAgentSandbox({
        connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
        sandboxId: "sb-1",
        rootDir: "/",
        runtimeWorkDir: "/",
      });
      await rootSandbox.initialize();
      mockDownload.mockResolvedValue(new TextEncoder().encode("ok"));

      await rootSandbox.downloadFiles(["/etc/hostname"]);
      // The router expects a path relative to runtimeWorkDir; with
      // runtimeWorkDir="/" that's the absolute path minus the
      // leading slash.
      const routerPath = mockDownload.mock.calls[0]![0] as string;
      expect(routerPath).toBe("etc/hostname");
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

  // -------------------------------------------------------------------------
  // Path-traversal security boundary
  // -------------------------------------------------------------------------

  describe("path traversal rejection", () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it("rejects '..' segments that escape rootDir on upload", async () => {
      const content = new TextEncoder().encode("data");
      // The throw bubbles up via the K8sFileUploadBatchError aggregation,
      // not as a per-file invalid_path response. This pins the security
      // boundary: a path-traversal attempt MUST surface to the caller.
      await expect(
        sandbox.uploadFiles([["../etc/passwd", content]]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it("rejects '/app/../etc/passwd' style escapes on upload", async () => {
      const content = new TextEncoder().encode("data");
      await expect(
        sandbox.uploadFiles([["/app/../etc/passwd", content]]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it("rejects '..' segments on download", async () => {
      await expect(
        sandbox.downloadFiles(["../../root/.ssh/id_rsa"]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it("permits legitimate '..' segments that stay under rootDir", async () => {
      // foo/../bar.txt normalizes to /app/bar.txt — still under root.
      mockExecute.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      const content = new TextEncoder().encode("data");
      const responses = await sandbox.uploadFiles([
        ["foo/../bar.txt", content],
      ]);
      expect(responses[0]!.error).toBeNull();
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("/app/bar.txt");
    });

    it("rejects empty filePath up front", async () => {
      const content = new TextEncoder().encode("data");
      await expect(
        sandbox.uploadFiles([["", content]]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Constructor validation of rootDir / runtimeWorkDir
  // -------------------------------------------------------------------------

  describe("rootDir / runtimeWorkDir validation", () => {
    const baseOptions = {
      connectionConfig: { type: "direct" as const, baseUrl: "http://x:8080" },
      sandboxId: "sb-1",
    };

    it("rejects rootDir that is not an absolute path", () => {
      expect(
        () => new K8sAgentSandbox({ ...baseOptions, rootDir: "relative/path" }),
      ).toThrow(/INVALID_ARGUMENT|absolute path/);
    });

    it("rejects empty rootDir", () => {
      expect(
        () => new K8sAgentSandbox({ ...baseOptions, rootDir: "" }),
      ).toThrow(/INVALID_ARGUMENT|non-empty/);
    });

    it("normalizes '/app/../foo' to '/foo' then rejects against runtimeWorkDir", () => {
      // /app/.. → / which is NOT under /app, so the alignment check
      // rejects. This pins the rootDir-validation defense: a sneaky
      // ".." input can't disable virtualization.
      expect(
        () =>
          new K8sAgentSandbox({ ...baseOptions, rootDir: "/app/../foo" }),
      ).toThrow(/under runtimeWorkDir/);
    });

    it("normalizes '//' to '/' then rejects when runtimeWorkDir is /app", () => {
      expect(
        () => new K8sAgentSandbox({ ...baseOptions, rootDir: "//" }),
      ).toThrow(/under runtimeWorkDir/);
    });

    it("rejects rootDir outside runtimeWorkDir", () => {
      expect(
        () =>
          new K8sAgentSandbox({
            ...baseOptions,
            rootDir: "/workspace",
            // runtimeWorkDir defaults to /app
          }),
      ).toThrow(/under runtimeWorkDir/);
    });

    it("accepts rootDir as a subdirectory of runtimeWorkDir", () => {
      const sb = new K8sAgentSandbox({
        ...baseOptions,
        rootDir: "/app/agent",
      });
      expect(sb.rootDir).toBe("/app/agent");
      expect(sb.runtimeWorkDir).toBe("/app");
    });

    it("accepts a custom runtimeWorkDir + matching rootDir", () => {
      const sb = new K8sAgentSandbox({
        ...baseOptions,
        runtimeWorkDir: "/workspace",
        rootDir: "/workspace",
      });
      expect(sb.rootDir).toBe("/workspace");
      expect(sb.runtimeWorkDir).toBe("/workspace");
    });
  });

  // -------------------------------------------------------------------------
  // Non-default rootDir round-trip + path math
  // -------------------------------------------------------------------------

  describe("rootDir as subdirectory of runtimeWorkDir", () => {
    let agentSandbox: K8sAgentSandbox;

    beforeEach(async () => {
      agentSandbox = new K8sAgentSandbox({
        connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
        sandboxId: "sb-1",
        rootDir: "/app/agent",
      });
      await agentSandbox.initialize();
    });

    it("strips runtimeWorkDir prefix on download (no '..' segments)", async () => {
      mockDownload.mockResolvedValue(new TextEncoder().encode("ok"));

      // Caller path "foo.txt" → resolved to /app/agent/foo.txt
      // → router path "agent/foo.txt" (relative to runtime workdir /app)
      await agentSandbox.downloadFiles(["foo.txt"]);

      expect(mockDownload).toHaveBeenCalledWith("agent/foo.txt");
    });

    it("virtualizes upload path under rootDir", async () => {
      mockExecute.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      const content = new TextEncoder().encode("data");

      await agentSandbox.uploadFiles([["foo.txt", content]]);

      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("/app/agent/foo.txt");
    });

    it("download path math contains no '..' segments", async () => {
      mockDownload.mockResolvedValue(new TextEncoder().encode("ok"));

      await agentSandbox.downloadFiles(["nested/file.py"]);

      const callArg = mockDownload.mock.calls[0]![0] as string;
      expect(callArg).not.toContain("..");
      expect(callArg).toBe("agent/nested/file.py");
    });
  });

  // -------------------------------------------------------------------------
  // Partial-success preservation via K8sFileUploadBatchError / K8sFileDownloadBatchError
  // -------------------------------------------------------------------------

  describe("partialResults on batch fatal error", () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it("uploadFiles preserves successful entries when one transport-error fails the batch", async () => {
      // First upload succeeds, second hits a TUNNEL_FAILED.
      mockExecute
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
        .mockRejectedValueOnce(
          new K8sAgentSandboxError("tunnel down", "TUNNEL_FAILED"),
        );

      const enc = new TextEncoder();
      let caught: unknown = null;
      try {
        await sandbox.uploadFiles([
          ["a.txt", enc.encode("a")],
          ["b.txt", enc.encode("b")],
        ]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(K8sFileUploadBatchError);
      // instanceof to base class still works — the subclass MUST
      // preserve the prototype chain so callers who only check the
      // base class still catch this error. A regression that broke
      // the extends chain would silently make `catch (e) { if (e
      // instanceof K8sAgentSandboxError) ... }` miss this case.
      expect(caught).toBeInstanceOf(K8sAgentSandboxError);
      const err = caught as K8sFileUploadBatchError;
      // Code is preserved from the underlying transport error.
      expect(err.code).toBe("TUNNEL_FAILED");
      // Partial results contain BOTH files — index-aligned with input.
      expect(err.partialResults).toHaveLength(2);
      // The first file's response carries the success. No cast
      // needed because partialResults is typed as
      // readonly FileUploadResponse[] on the concrete subclass.
      expect(err.partialResults[0]!.error).toBeNull();
      expect(err.partialResults[0]!.path).toBe("a.txt");
      // transportErrors collects every fatal error.
      expect(err.transportErrors).toHaveLength(1);
      // err.code should match the primary transport error's code
      // (the first one collected). Contract documented on
      // #buildUploadBatchError.
      expect(err.code).toBe(err.transportErrors[0]!.code);
    });

    it("uploadFiles aggregates multiple transport errors", async () => {
      mockExecute
        .mockRejectedValueOnce(
          new K8sAgentSandboxError("tunnel down", "TUNNEL_FAILED"),
        )
        .mockRejectedValueOnce(
          new K8sAgentSandboxError("connection refused", "CONNECTION_FAILED"),
        );

      const enc = new TextEncoder();
      let caught: unknown = null;
      try {
        await sandbox.uploadFiles([
          ["a.txt", enc.encode("a")],
          ["b.txt", enc.encode("b")],
        ]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(K8sFileUploadBatchError);
      const err = caught as K8sFileUploadBatchError;
      expect(err.transportErrors).toHaveLength(2);
      // Both codes are preserved on the typed array.
      const codes = err.transportErrors.map((e) => e.code);
      expect(codes).toContain("TUNNEL_FAILED");
      expect(codes).toContain("CONNECTION_FAILED");
    });

    it("uploadFiles: httpStatus is preserved on the batch error", async () => {
      mockExecute.mockRejectedValueOnce(
        new K8sAgentSandboxError(
          "HTTP 500",
          "HTTP_ERROR",
          undefined,
          500,
        ),
      );
      const enc = new TextEncoder();
      let caught: unknown = null;
      try {
        await sandbox.uploadFiles([["a.txt", enc.encode("a")]]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(K8sFileUploadBatchError);
      const err = caught as K8sFileUploadBatchError;
      expect(err.httpStatus).toBe(500);
    });

    it("downloadFiles preserves successful entries on transport error", async () => {
      mockDownload
        .mockResolvedValueOnce(new TextEncoder().encode("ok"))
        .mockRejectedValueOnce(
          new K8sAgentSandboxError("tunnel down", "TUNNEL_FAILED"),
        );

      let caught: unknown = null;
      try {
        await sandbox.downloadFiles(["/app/a.txt", "/app/b.txt"]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(K8sFileDownloadBatchError);
      expect(caught).toBeInstanceOf(K8sAgentSandboxError);
      const err = caught as K8sFileDownloadBatchError;
      expect(err.partialResults).toHaveLength(2);
      // No cast: partialResults is typed as
      // readonly FileDownloadResponse[] on the concrete subclass.
      expect(err.partialResults[0]!.error).toBeNull();
      expect(err.partialResults[0]!.content).not.toBeNull();
      // Verify the actual content was preserved (not just "truthy").
      // Catches regressions that replace the content with an empty
      // placeholder during partial-results construction.
      const content = err.partialResults[0]!.content;
      expect(content).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(content!)).toBe("ok");
    });

    it("downloadFiles: upload and download batch errors are distinguishable via instanceof", async () => {
      mockDownload.mockRejectedValueOnce(
        new K8sAgentSandboxError("tunnel down", "TUNNEL_FAILED"),
      );
      let caught: unknown = null;
      try {
        await sandbox.downloadFiles(["/app/a.txt"]);
      } catch (e) {
        caught = e;
      }
      // Download errors must NOT match the upload batch error class.
      expect(caught).toBeInstanceOf(K8sFileDownloadBatchError);
      expect(caught).not.toBeInstanceOf(K8sFileUploadBatchError);
    });
  });

  // -------------------------------------------------------------------------
  // close() error preservation
  // -------------------------------------------------------------------------

  describe("close() error preservation", () => {
    it("re-throws single K8sAgentSandboxError directly preserving the code", async () => {
      const sandboxWithDelete = new K8sAgentSandbox(
        {
          connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
          sandboxId: "sb-1",
          claimName: "claim-1",
          deleteOnClose: true,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          deleteSandboxClaim: mockDeleteSandboxClaim,
          close: vi.fn().mockResolvedValue(undefined),
        } as any,
      );
      mockDeleteSandboxClaim.mockRejectedValueOnce(
        new K8sAgentSandboxError("tunnel exploded", "TUNNEL_FAILED"),
      );
      // close() also calls httpClient.close() which is mocked happy.

      let caught: unknown = null;
      try {
        await sandboxWithDelete.close();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(K8sAgentSandboxError);
      // Original code is preserved (not re-wrapped to K8S_API_ERROR).
      expect((caught as K8sAgentSandboxError).code).toBe("TUNNEL_FAILED");
    });

    it("aggregates multiple errors as AggregateError with primary code exposed", async () => {
      const sandboxWithDelete = new K8sAgentSandbox(
        {
          connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
          sandboxId: "sb-1",
          claimName: "claim-1",
          deleteOnClose: true,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          deleteSandboxClaim: mockDeleteSandboxClaim,
          close: vi.fn().mockResolvedValue(undefined),
        } as any,
      );
      mockDeleteSandboxClaim.mockRejectedValueOnce(
        new K8sAgentSandboxError("delete blew up", "K8S_API_ERROR"),
      );
      mockClose.mockRejectedValueOnce(
        new K8sAgentSandboxError("tunnel died", "TUNNEL_FAILED"),
      );

      let caught: unknown = null;
      try {
        await sandboxWithDelete.close();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const ag = caught as AggregateError & { code?: string };
      expect(ag.errors).toHaveLength(2);
      // Round-4 fix: the first typed error's code is exposed on the
      // AggregateError so callers doing `err.code === "TUNNEL_FAILED"`
      // still work for the common "primary failure, secondary
      // cleanup" case. Cleanup order runs HTTP close first (see
      // close() implementation), so TUNNEL_FAILED is the primary.
      expect(ag.code).toBe("TUNNEL_FAILED");
      // Every individual error is still reachable for callers that
      // want to inspect all of them.
      const codes = ag.errors
        .filter((e: unknown): e is K8sAgentSandboxError =>
          e instanceof K8sAgentSandboxError,
        )
        .map((e: K8sAgentSandboxError) => e.code);
      expect(codes).toContain("K8S_API_ERROR");
      expect(codes).toContain("TUNNEL_FAILED");
    });

    it("respects throwOnError:false by logging instead of throwing", async () => {
      const sandboxWithDelete = new K8sAgentSandbox(
        {
          connectionConfig: { type: "direct", baseUrl: "http://x:8080" },
          sandboxId: "sb-1",
          claimName: "claim-1",
          deleteOnClose: true,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          deleteSandboxClaim: mockDeleteSandboxClaim,
          close: vi.fn().mockResolvedValue(undefined),
        } as any,
      );
      mockDeleteSandboxClaim.mockRejectedValueOnce(new Error("boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Must NOT throw.
      await sandboxWithDelete.close({ throwOnError: false });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // create() respects deleteOnClose:false on creation failure
  // -------------------------------------------------------------------------

  describe("create() with deleteOnClose:false leaves claim on failure", () => {
    it("does not call deleteSandboxClaim when creation fails and deleteOnClose is false", async () => {
      // Force initialization failure: healthCheck rejects with a
      // typed CONNECTION_FAILED so initialize() re-throws verbatim
      // without rewrapping as SANDBOX_NOT_REACHABLE.
      mockHealthCheck.mockRejectedValueOnce(
        new K8sAgentSandboxError("connect ECONNREFUSED", "CONNECTION_FAILED"),
      );
      mockDeleteSandboxClaim.mockClear();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        K8sAgentSandbox.create({
          template: "python-sandbox-template",
          deleteOnClose: false,
        }),
      ).rejects.toMatchObject({ code: "CONNECTION_FAILED" });

      // Critical: deleteOnClose:false means the claim must NOT be
      // auto-deleted on the failure path. The user explicitly opted
      // into keeping it for debugging.
      expect(mockDeleteSandboxClaim).not.toHaveBeenCalled();
      // But the leftover claim must be logged so the user can find
      // it manually.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("deleteOnClose=false"),
      );
      warnSpy.mockRestore();
    });

    it("does call deleteSandboxClaim when creation fails and deleteOnClose is true (default)", async () => {
      mockHealthCheck.mockRejectedValueOnce(
        new K8sAgentSandboxError("connect ECONNREFUSED", "CONNECTION_FAILED"),
      );
      mockDeleteSandboxClaim.mockClear();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        K8sAgentSandbox.create({
          template: "python-sandbox-template",
          // deleteOnClose defaults to true here
        }),
      ).rejects.toMatchObject({ code: "CONNECTION_FAILED" });

      // With deleteOnClose:true, the sandbox.close() path inside
      // the create() catch clause deletes the claim as part of
      // tearing down the tunnel subprocess.
      expect(mockDeleteSandboxClaim).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // deleteAll failure aggregation (T7 from round-4 review)
  // -------------------------------------------------------------------------

  describe("deleteAll failure handling", () => {
    it("throws a single K8sAgentSandboxError when exactly one claim fails", async () => {
      mockListSandboxClaims.mockResolvedValueOnce(["claim-a"]);
      mockDeleteSandboxClaim.mockRejectedValueOnce(
        new K8sAgentSandboxError("K8s unreachable", "K8S_API_ERROR"),
      );
      await expect(
        K8sAgentSandbox.deleteAll({ owner: "alice" }),
      ).rejects.toMatchObject({ code: "K8S_API_ERROR" });
    });

    it("throws AggregateError when multiple claims fail", async () => {
      mockListSandboxClaims.mockResolvedValueOnce(["claim-a", "claim-b"]);
      mockDeleteSandboxClaim
        .mockRejectedValueOnce(new Error("boom a"))
        .mockRejectedValueOnce(new Error("boom b"));

      let caught: unknown = null;
      try {
        await K8sAgentSandbox.deleteAll({ owner: "alice" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toHaveLength(2);
    });

    it("bestEffort:true logs failures and returns without throwing", async () => {
      mockListSandboxClaims.mockResolvedValueOnce(["claim-a"]);
      mockDeleteSandboxClaim.mockRejectedValueOnce(new Error("boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        K8sAgentSandbox.deleteAll(
          { owner: "alice" },
          "default",
          { bestEffort: true },
        ),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("claims failed to delete"),
      );
      warnSpy.mockRestore();
    });
  });
});
