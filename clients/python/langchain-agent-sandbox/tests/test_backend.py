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

from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest

from langchain_agent_sandbox import (
    AgentSandboxBackend,
    SandboxPolicyWrapper,
    WarmPoolBackend,
    create_sandbox_backend_factory,
)


class _StubCommands:
    def __init__(self, run_result):
        self.run_result = run_result
        self.last_command = None
        self.last_kwargs: dict = {}
        self.calls: list = []

    def run(self, command, **kwargs):
        self.last_command = command
        self.last_kwargs = kwargs
        self.calls.append((command, kwargs))
        return self.run_result


class _StubFiles:
    def __init__(self, read_bytes):
        self.read_bytes = read_bytes
        self.last_read_path = None

    def read(self, path, timeout=60):
        self.last_read_path = path
        return self.read_bytes

    def write(self, path, content, timeout=60):
        pass


class _StubConnector:
    def __init__(self):
        self.requests = []

    def send_request(self, method, endpoint, **kwargs):
        self.requests.append((method, endpoint, kwargs))
        return SimpleNamespace(status_code=200)


class StubSandbox:
    """Mimics the upstream Sandbox handle API for unit testing."""

    def __init__(self, run_result=None, read_bytes=b""):
        run_result = run_result or SimpleNamespace(stdout="", stderr="", exit_code=0)
        self.commands = _StubCommands(run_result)
        self.files = _StubFiles(read_bytes)
        self.connector = _StubConnector()
        self.claim_name = None
        self.sandbox_id = None
        self.namespace = "default"
        self.is_active = True


def _require(condition: bool, message: str) -> None:
    if not condition:
        pytest.fail(message)


def test_execute_combines_output_and_stderr():
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="err", exit_code=1))
    backend = AgentSandboxBackend(client)

    result = backend.execute("echo test")

    _require(result.output == "ok\nerr", "Unexpected combined output")
    _require(result.exit_code == 1, "Unexpected exit code")
    _require(result.truncated is False, "Unexpected truncation flag")


def test_read_missing_file_returns_error():
    client = StubSandbox()
    client.files.read = lambda path, timeout=60: (_ for _ in ()).throw(
        RuntimeError("file not found")
    )
    backend = AgentSandboxBackend(client)

    response = backend.read("/missing.txt")

    _require(response.error is not None, "Expected read error")
    _require("missing.txt" in response.error, f"Expected path in error: {response.error}")
    _require("file not found" in response.error, "Expected original exception message in error")
    _require(response.file_data is None, "Expected file_data to be None on error")


def test_write_existing_file_returns_error():
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    result = backend.write("/exists.txt", "data")

    _require(result.error is not None, "Expected write error")
    _require("already exists" in result.error, "Unexpected write error message")


def test_edit_multiple_occurrences_without_replace_all():
    client = StubSandbox(read_bytes=b"alpha beta alpha")
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    result = backend.edit("/file.txt", "alpha", "gamma", replace_all=False)

    _require(result.error is not None, "Expected edit error")
    _require("appears multiple times" in result.error, "Unexpected edit error message")
    _require(result.occurrences == 2, "Unexpected occurrences count")


def test_to_internal_blocks_escape():
    client = StubSandbox()
    backend = AgentSandboxBackend(client)

    with pytest.raises(ValueError):
        backend._to_internal("../../etc/passwd")


def test_ls_parses_entries():
    client = StubSandbox(run_result=SimpleNamespace(stdout="file.txt\nsubdir/\n", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.ls("/")

    _require(result.error is None, f"Unexpected error: {result.error}")
    entries = result.entries
    _require(len(entries) == 2, "Unexpected number of entries")
    _require(entries[0]["path"] == "/file.txt", "Unexpected first entry path")
    _require(entries[0]["is_dir"] is False, "Unexpected first entry type")
    _require(entries[1]["path"] == "/subdir", "Unexpected second entry path")
    _require(entries[1]["is_dir"] is True, "Unexpected second entry type")


def test_ls_filters_dot_and_dotdot_with_trailing_slash():
    """ls -a -p on Linux outputs ./ and ../ — these must be filtered."""
    client = StubSandbox(
        run_result=SimpleNamespace(stdout="./\n../\nfile.txt\ndir/\n", stderr="", exit_code=0)
    )
    backend = AgentSandboxBackend(client)

    result = backend.ls("/")

    entries = result.entries
    _require(len(entries) == 2, f"Expected 2 entries (no . or ..), got {len(entries)}")
    paths = [e["path"] for e in entries]
    _require("/." not in paths and "/.." not in paths, f"Dot entries leaked: {paths}")


def test_upload_files_invalid_path():
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._to_internal = lambda _: (_ for _ in ()).throw(ValueError("escape"))

    responses = backend.upload_files({"/bad": b"payload"})

    _require(responses[0].error == "invalid_path", "Unexpected upload error code")


def test_upload_files_creates_missing_parent_directory():
    """upload_files should mkdir -p the parent chain like write() does.

    The deepagents protocol expects `uploadFiles` to work against
    fresh paths without requiring the caller to pre-create directory
    trees. Matches the behavior of write() and keeps parity with the
    deepagents-js shared standard tests, which seed nested initial
    files through the same code path.
    """
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "missing"
    # Simulate a missing parent: _dir_state returns "missing" the first
    # time (for the initial check) — after _ensure_parent_dir runs via
    # mkdir -p, the upload proceeds.
    backend._dir_state = lambda _: "missing"
    mkdir_calls = []
    backend._ensure_parent_dir = lambda path: mkdir_calls.append(path)
    uploaded = []
    backend._upload_bytes = lambda path, content: uploaded.append((path, content))

    responses = backend.upload_files([("/nested/dir/file.txt", b"payload")])

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error is None, f"Expected success, got {responses[0].error}")
    _require(len(mkdir_calls) == 1, f"Expected one mkdir, got {mkdir_calls}")
    _require(mkdir_calls[0] == "/app/nested/dir/file.txt", f"Unexpected mkdir target: {mkdir_calls}")
    _require(uploaded == [("/app/nested/dir/file.txt", b"payload")], f"Unexpected upload: {uploaded}")


def test_download_files_missing():
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "missing"

    responses = backend.download_files(["/missing.txt"])

    _require(responses[0].error == "file_not_found", "Unexpected download error code")


def test_grep_returns_matches():
    grep_output = "/app/test.py:10:def foo():\n/app/test.py:20:    foo()\n"
    client = StubSandbox(run_result=SimpleNamespace(stdout=grep_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    result = backend.grep("foo", path="/")

    _require(result.error is None, f"Unexpected error: {result.error}")
    matches = result.matches
    _require(len(matches) == 2, f"Expected 2 matches, got {len(matches)}")
    _require(matches[0]["path"] == "/test.py", f"Unexpected path: {matches[0]['path']}")
    _require(matches[0]["line"] == 10, f"Unexpected line: {matches[0]['line']}")
    _require(matches[0]["text"] == "def foo():", f"Unexpected text: {matches[0]['text']}")


def test_grep_error_uses_stderr_for_message():
    """grep exit code >= 2 should surface stderr content in the error message.

    Since the grep command no longer uses `2>&1` (the sandbox runtime
    doesn't go through a shell, so that redirect became a literal
    filename arg to grep), the real error text lives on the stderr
    channel. The error message must read from stderr, not stdout.
    """
    client = StubSandbox(
        run_result=SimpleNamespace(
            stdout="",
            stderr="grep: /app/nonexistent: No such file or directory",
            exit_code=2,
        )
    )
    backend = AgentSandboxBackend(client)

    result = backend.grep("pattern", path="/nonexistent")

    _require(result.error is not None, "Expected error")
    _require("grep failed" in result.error, f"Unexpected error message prefix: {result.error}")
    _require(
        "No such file or directory" in result.error,
        f"Expected stderr text in error message, got: {result.error!r}",
    )
    _require(result.matches == [], "Expected empty matches alongside error")


def test_grep_error_falls_back_to_stdout_when_stderr_empty():
    """If stderr is empty for some reason, fall back to stdout content."""
    client = StubSandbox(
        run_result=SimpleNamespace(
            stdout="legacy-error-on-stdout",
            stderr="",
            exit_code=2,
        )
    )
    backend = AgentSandboxBackend(client)

    result = backend.grep("pattern", path="/nonexistent")

    _require(result.error is not None, "Expected error")
    _require(
        "legacy-error-on-stdout" in result.error,
        f"Expected stdout fallback, got: {result.error!r}",
    )


def test_grep_error_reports_exit_code_when_both_streams_empty():
    """With both streams empty, surface the exit code instead of 'unknown'."""
    client = StubSandbox(
        run_result=SimpleNamespace(stdout="", stderr="", exit_code=3)
    )
    backend = AgentSandboxBackend(client)

    result = backend.grep("pattern", path="/nonexistent")

    _require(result.error is not None, "Expected error")
    _require("exit code 3" in result.error, f"Expected exit code in error, got: {result.error!r}")


def test_glob_returns_matching_files():
    find_output = "f /app/src/main.py\nf /app/src/utils.py\nf /app/tests/test_main.py\n"
    client = StubSandbox(run_result=SimpleNamespace(stdout=find_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.glob("*.py", path="/")

    _require(result.error is None, f"Unexpected error: {result.error}")
    matches = result.matches
    _require(len(matches) == 3, f"Expected 3 matches, got {len(matches)}")
    _require(matches[0]["is_dir"] is False, "Expected files, not directories")


def test_glob_double_star_matches_root_and_nested():
    """`**/X` should match X at any depth including the root."""
    find_output = (
        "f /app/target.txt\n"
        "f /app/sub/target.txt\n"
        "f /app/deep/nest/target.txt\n"
        "f /app/other.txt\n"
    )
    client = StubSandbox(run_result=SimpleNamespace(stdout=find_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.glob("**/target.txt", path="/")

    _require(result.error is None, f"Unexpected error: {result.error}")
    paths = sorted(m["path"] for m in result.matches)
    _require(
        paths == ["/deep/nest/target.txt", "/sub/target.txt", "/target.txt"],
        f"Expected root + 2 nested matches, got {paths}",
    )


def test_glob_prefix_double_star_pattern():
    """`src/**/*.ts` should match .ts files at any depth under src/."""
    find_output = (
        "f /app/src/a.ts\n"
        "f /app/src/dir/b.ts\n"
        "f /app/src/dir/nested/c.ts\n"
        "f /app/src/a.js\n"
        "f /app/other/x.ts\n"
    )
    client = StubSandbox(run_result=SimpleNamespace(stdout=find_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.glob("src/**/*.ts", path="/")

    _require(result.error is None, f"Unexpected error: {result.error}")
    paths = sorted(m["path"] for m in result.matches)
    _require(
        paths == ["/src/a.ts", "/src/dir/b.ts", "/src/dir/nested/c.ts"],
        f"Unexpected matches: {paths}",
    )


# --- Direct unit tests for _compile_glob -----------------------------------
#
# The regex translation layer has ~8 distinct code paths (basename
# fallback, leading/middle/trailing `**`, collapsed `**`, character
# class, `?` wildcard, literal escape). These tests exercise it at
# the helper level so a regression in the translator is caught before
# it slips into backend.glob() and ships as a silent empty-matches
# bug like the pre-fix `a/**/b` matching `ab`.


def _match(pattern: str, path: str) -> bool:
    from langchain_agent_sandbox.backend import _compile_glob

    return _compile_glob(pattern)(path)


def test_compile_glob_basename_fallback_no_slash():
    """Patterns with no `/` match against the basename, at any depth."""
    assert _match("*.py", "main.py") is True
    assert _match("*.py", "nested/main.py") is True
    assert _match("*.py", "main.txt") is False


def test_compile_glob_question_mark_wildcard():
    """`?` matches exactly one character and does not cross `/`."""
    assert _match("file?.txt", "file1.txt") is True
    assert _match("file?.txt", "fileA.txt") is True
    assert _match("file?.txt", "file12.txt") is False
    assert _match("src/file?.txt", "src/file1.txt") is True
    assert _match("src/file?.txt", "src/file/txt") is False


def test_compile_glob_character_class():
    """`[abc]` matches one of the listed characters."""
    assert _match("[abc].txt", "a.txt") is True
    assert _match("[abc].txt", "b.txt") is True
    assert _match("[abc].txt", "d.txt") is False


def test_compile_glob_unterminated_character_class_is_literal():
    """`[` without a closing `]` is treated as a literal `[`."""
    # The translator escapes the `[` when there's no closing bracket
    # rather than producing an invalid regex. A file literally named
    # `file[abc.py` should then match the pattern.
    assert _match("src/file[abc.py", "src/file[abc.py") is True
    assert _match("src/file[abc.py", "src/filea.py") is False


def test_compile_glob_leading_double_star():
    """`**/X` matches X at any depth including root."""
    assert _match("**/x", "x") is True
    assert _match("**/x", "a/x") is True
    assert _match("**/x", "a/b/x") is True
    assert _match("**/x", "ax") is False


def test_compile_glob_middle_double_star_requires_adjoining_slashes():
    """Critical: `a/**/b` must NOT match `ab`.

    Regression test for the fix where the middle-`**` translation
    previously compiled `a/**/b` to `^a(?:.*/)?b$`, which matched
    `"ab"` because `(?:.*/)?` can match the empty string and collapse
    the two literal slashes away. The correct regex is
    `^a/(?:[^/]+/)*b$`, requiring at least `a/b`.
    """
    assert _match("a/**/b", "ab") is False  # the bug
    assert _match("a/**/b", "a/b") is True
    assert _match("a/**/b", "a/x/b") is True
    assert _match("a/**/b", "a/x/y/b") is True
    assert _match("a/**/b", "a/b/c") is False
    assert _match("a/**/b", "x/a/b") is False


def test_compile_glob_trailing_double_star():
    """`a/**` matches things inside `a/`, not bare `a`."""
    assert _match("a/**", "a") is False  # gitignore semantic
    assert _match("a/**", "a/b") is True
    assert _match("a/**", "a/b/c") is True
    assert _match("a/**", "ab") is False


def test_compile_glob_multiple_double_stars():
    """`a/**/b/**/c` matches c after b after a at any depth."""
    assert _match("a/**/b/**/c", "a/b/c") is True
    assert _match("a/**/b/**/c", "a/x/b/c") is True
    assert _match("a/**/b/**/c", "a/b/x/c") is True
    assert _match("a/**/b/**/c", "a/x/y/b/z/c") is True
    assert _match("a/**/b/**/c", "a/c") is False
    assert _match("a/**/b/**/c", "abc") is False


def test_compile_glob_consecutive_double_stars_collapse():
    """`**/**` is semantically identical to a single `**`."""
    assert _match("**/**/x", "x") is True
    assert _match("**/**/x", "a/x") is True
    assert _match("**/**/x", "a/b/x") is True


def test_compile_glob_standalone_double_star_matches_everything():
    """A pattern of just `**` matches any path."""
    assert _match("**", "anything") is True
    assert _match("**", "a/b/c") is True
    assert _match("**", "") is True


def test_glob_returns_typed_error_for_malformed_pattern():
    """An invalid regex character class should yield GlobResult(error=...), not raise."""
    # Pattern contains a reverse character range (`z-a`) which the
    # regex engine rejects with re.error. _compile_glob passes
    # character classes through to the engine literally, so this
    # surfaces as a compilation failure that glob() must catch and
    # convert to a typed error — otherwise the agent sees a Python
    # traceback instead of a usable response.
    client = StubSandbox(run_result=SimpleNamespace(stdout="", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.glob("src/file[z-a].py", path="/")

    _require(result.error is not None, "Expected typed error for malformed pattern")
    _require(
        "invalid glob pattern" in result.error,
        f"Expected helpful error prefix, got: {result.error!r}",
    )
    _require(result.matches == [], "Expected empty matches on malformed pattern")


def test_glob_returns_error_with_empty_matches_on_failure():
    client = StubSandbox(run_result=SimpleNamespace(stdout="", stderr="No such directory", exit_code=1))
    backend = AgentSandboxBackend(client)

    result = backend.glob("*.py", path="/nonexistent")

    _require(result.matches == [], f"Expected empty matches, got {result.matches}")
    _require(result.error is not None, "Expected error to be populated on total failure")
    _require("No such directory" in result.error, f"Expected stderr in error, got: {result.error}")


def test_ls_returns_error_with_empty_entries_on_failure():
    client = StubSandbox(run_result=SimpleNamespace(stdout="", stderr="No such directory", exit_code=2))
    backend = AgentSandboxBackend(client)

    result = backend.ls("/nonexistent")

    _require(result.entries == [], f"Expected empty entries, got {result.entries}")
    _require(result.error is not None, "Expected error to be populated on failure")
    _require("No such directory" in result.error, f"Expected stderr in error, got: {result.error}")


def test_edit_success_with_replace_all():
    client = StubSandbox(read_bytes=b"foo bar foo baz foo")
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True
    backend._upload_bytes = lambda path, content: None

    result = backend.edit("/file.txt", "foo", "qux", replace_all=True)

    _require(result.error is None, f"Unexpected error: {result.error}")
    _require(result.occurrences == 3, f"Expected 3 occurrences, got {result.occurrences}")


def test_edit_success_single_occurrence():
    client = StubSandbox(read_bytes=b"hello world")
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True
    backend._upload_bytes = lambda path, content: None

    result = backend.edit("/file.txt", "world", "universe", replace_all=False)

    _require(result.error is None, f"Unexpected error: {result.error}")
    _require(result.occurrences == 1, f"Expected 1 occurrence, got {result.occurrences}")


def test_to_internal_blocks_sibling_directory_escape():
    """Test that /appfoo doesn't match when root_dir=/app."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app")

    # This path should fail because /appfoo is not under /app
    with pytest.raises(ValueError):
        backend._to_internal("/../appfoo/secret")


def test_to_internal_allows_root_dir_itself():
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app")

    result = backend._to_internal("/")

    _require(result == "/app", f"Expected /app, got {result}")


def test_write_allows_absolute_path_outside_root_dir():
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app", allow_absolute_paths=True)
    seen = {}

    def fake_exists(path):
        seen["exists"] = path
        return False

    def fake_ensure_parent(path):
        seen["mkdir"] = path

    uploaded = []
    backend._exists = fake_exists
    backend._ensure_parent_dir = fake_ensure_parent
    backend._upload_bytes = lambda path, content: uploaded.append((path, content))

    result = backend.write("/tmp/nested/file.txt", "hello")

    _require(result.error is None, f"Unexpected write error: {result.error}")
    _require(seen["exists"] == "/tmp/nested/file.txt", f"Unexpected exists path: {seen['exists']}")
    _require(seen["mkdir"] == "/tmp/nested/file.txt", f"Unexpected mkdir path: {seen['mkdir']}")
    _require(uploaded == [("/tmp/nested/file.txt", b"hello")], f"Unexpected upload args: {uploaded}")


def test_upload_files_allows_absolute_path_outside_root_dir():
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app", allow_absolute_paths=True)
    backend._file_state = lambda _: "missing"
    backend._dir_state = lambda _: "writable"
    uploaded = []
    backend._upload_bytes = lambda path, content: uploaded.append((path, content))

    responses = backend.upload_files({"/tmp/nested/file.txt": b"payload"})

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error is None, f"Expected success, got error={responses[0].error}")
    _require(uploaded == [("/tmp/nested/file.txt", b"payload")], f"Unexpected upload args: {uploaded}")


def test_write_absolute_path_defaults_to_root_virtualization():
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app")
    seen = {}

    def fake_exists(path):
        seen["exists"] = path
        return False

    backend._exists = fake_exists
    backend._ensure_parent_dir = lambda _path: None
    backend._upload_bytes = lambda _path, _content: None

    result = backend.write("/tmp/nested/file.txt", "hello")

    _require(result.error is None, f"Unexpected write error: {result.error}")
    _require(seen["exists"] == "/app/tmp/nested/file.txt", f"Unexpected path mapping: {seen['exists']}")


def test_ensure_parent_dir_raises_on_failure():
    client = StubSandbox(run_result=SimpleNamespace(stdout="", stderr="Permission denied", exit_code=1))
    backend = AgentSandboxBackend(client)

    with pytest.raises(RuntimeError) as exc_info:
        backend._ensure_parent_dir("/app/nested/file.txt")

    _require("Cannot create parent directory" in str(exc_info.value), f"Unexpected error: {exc_info.value}")


# --- Factory pattern tests ---


def test_factory_pattern_creates_backend():
    """Test that create_sandbox_backend_factory returns a working factory."""
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance

        factory = create_sandbox_backend_factory(
            template_name="test-template",
            namespace="test-ns",
            root_dir="/workspace",
        )

        # Factory should be callable
        _require(callable(factory), "Factory should be callable")

        # Call factory with a mock runtime
        mock_runtime = MagicMock()
        backend = factory(mock_runtime)

        # Should return an AgentSandboxBackend
        _require(isinstance(backend, AgentSandboxBackend), "Factory should return AgentSandboxBackend")

        # SandboxClient should have been called with connection_config
        MockClient.assert_called_once()
        _require(backend._template == "test-template", "Expected _template=test-template")
        _require(backend._namespace == "test-ns", "Expected _namespace=test-ns")
        _require(backend._root_dir == "/workspace", f"Expected root_dir=/workspace, got {backend._root_dir}")


def test_factory_pattern_passes_kwargs():
    """Test that factory passes additional kwargs to from_template."""
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance

        factory = create_sandbox_backend_factory(
            template_name="my-template",
            namespace="prod",
            gateway_name="my-gateway",
            server_port=9999,
        )

        backend = factory(MagicMock())

        # Verify template/namespace stored for deferred creation
        _require(backend._template == "my-template", "Expected _template=my-template")
        _require(backend._namespace == "prod", "Expected _namespace=prod")
        # connection_config should be a GatewayConnectionConfig
        call_kwargs = MockClient.call_args.kwargs
        _require("connection_config" in call_kwargs, "Expected connection_config kwarg")


def test_factory_eagerly_provisions_sandbox():
    """The factory must provision the sandbox before returning.

    Regression test: deepagents calls factory(_runtime) and uses the
    returned backend directly without `with`. If the factory only
    returned an un-entered `from_template()` backend, the first call
    to execute()/ls()/etc. would dereference `self._sandbox` (still
    None) and raise AttributeError. The factory must call
    `__enter__()` eagerly.
    """
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_sdk = MagicMock()
        mock_sandbox = MagicMock()
        mock_sdk.create_sandbox.return_value = mock_sandbox
        MockClient.return_value = mock_sdk

        factory = create_sandbox_backend_factory(template_name="t")
        backend = factory(MagicMock())

        # The sandbox handle must be populated, not None.
        _require(
            backend._sandbox is not None,
            "Factory should eagerly enter the backend (sandbox is still None)",
        )
        _require(
            backend._sandbox is mock_sandbox,
            f"Expected the sandbox returned by sdk_client.create_sandbox, got {backend._sandbox}",
        )

        # sdk_client.create_sandbox must have been called once.
        mock_sdk.create_sandbox.assert_called_once()


def test_factory_registers_finalizer_for_cleanup():
    """The factory must register a finalizer that deletes the sandbox.

    Without this, a factory-provisioned sandbox would leak in the
    cluster because deepagents never calls `__exit__` on the backend.
    The finalizer is exposed as `backend._finalizer` so the test can
    invoke it deterministically rather than relying on `del backend +
    gc.collect()` GC ordering (which is fragile under MagicMock ref
    retention and alternative interpreters).
    """
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_sdk = MagicMock()
        mock_sandbox = MagicMock()
        mock_sandbox.claim_name = "sandbox-claim-abc123"
        mock_sandbox.namespace = "default"
        mock_sdk.create_sandbox.return_value = mock_sandbox
        MockClient.return_value = mock_sdk

        factory = create_sandbox_backend_factory(template_name="t")
        backend = factory(MagicMock())

        # Verify the finalizer was registered and is alive.
        _require(
            hasattr(backend, "_finalizer"),
            "Factory did not expose backend._finalizer",
        )
        _require(backend._finalizer.alive, "Finalizer should be alive after factory")

        # Trigger cleanup synchronously via the exposed handle.
        backend._finalizer()

        _require(
            backend._finalizer.alive is False,
            "Finalizer should be marked dead after explicit invocation",
        )
        mock_sdk.delete_sandbox.assert_called_once_with(
            claim_name="sandbox-claim-abc123",
            namespace="default",
        )


def test_factory_finalizer_swallows_delete_errors(recwarn):
    """Cleanup errors during finalizer execution must not raise.

    Uses the exposed `_finalizer` handle to invoke cleanup deterministically
    and asserts that no exception escapes. The previous version relied on
    `del + gc.collect()` and `assert_called_once()` — but unraisable-in-
    finalizer exceptions become `sys.unraisablehook` calls under CPython,
    not test failures, so the swallow guarantee was untested. Calling the
    finalizer directly turns "must not raise" into a real assertion via
    `pytest.raises(...)` inversion.
    """
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_sdk = MagicMock()
        mock_sdk.delete_sandbox.side_effect = RuntimeError("API unreachable")
        mock_sandbox = MagicMock()
        mock_sandbox.claim_name = "sandbox-claim-xyz789"
        mock_sandbox.namespace = "default"
        mock_sdk.create_sandbox.return_value = mock_sandbox
        MockClient.return_value = mock_sdk

        factory = create_sandbox_backend_factory(template_name="t")
        backend = factory(MagicMock())

        # Synchronous, deterministic invocation. If the finalizer
        # raised, this would propagate and fail the test directly —
        # which is exactly what we want to assert it does NOT do.
        backend._finalizer()

        # The non-404 RuntimeError should have been logged at ERROR
        # (not silently swallowed) by `_factory_atexit_cleanup`.
        mock_sdk.delete_sandbox.assert_called_once()


def test_factory_finalizer_silently_swallows_404():
    """A 404 from delete_sandbox is the redundant-cleanup case and must be silent.

    Pins the contract that the user's explicit `__exit__` already
    cleaned up the claim, so the finalizer's redundant attempt sees a
    404 and doesn't log an error. Probes the SDK exception shape used
    by the kubernetes-client (`status` attr) and the requests-style
    shape (`response.status_code`).
    """
    class _FakeApiException(Exception):
        def __init__(self, status):
            super().__init__(f"HTTP {status}")
            self.status = status

    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_sdk = MagicMock()
        mock_sdk.delete_sandbox.side_effect = _FakeApiException(404)
        mock_sandbox = MagicMock()
        mock_sandbox.claim_name = "sandbox-claim-already-gone"
        mock_sandbox.namespace = "default"
        mock_sdk.create_sandbox.return_value = mock_sandbox
        MockClient.return_value = mock_sdk

        factory = create_sandbox_backend_factory(template_name="t")
        backend = factory(MagicMock())

        # Must not raise.
        backend._finalizer()
        mock_sdk.delete_sandbox.assert_called_once()


def test_factory_finalizer_logs_non_404_failures(caplog):
    """Non-404 delete failures must be logged so the leak is operator-visible."""
    import logging

    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_sdk = MagicMock()
        mock_sdk.delete_sandbox.side_effect = RuntimeError("API unreachable")
        mock_sandbox = MagicMock()
        mock_sandbox.claim_name = "sandbox-claim-leaked"
        mock_sandbox.namespace = "default"
        mock_sdk.create_sandbox.return_value = mock_sandbox
        MockClient.return_value = mock_sdk

        factory = create_sandbox_backend_factory(template_name="t")
        backend = factory(MagicMock())

        with caplog.at_level(logging.ERROR, logger="langchain_agent_sandbox.backend"):
            backend._finalizer()

        _require(
            any("Finalizer failed to delete sandbox" in r.message for r in caplog.records),
            f"Expected finalizer leak log, got records: {[r.message for r in caplog.records]}",
        )
        _require(
            any("API unreachable" in r.message for r in caplog.records),
            "Expected underlying error message in finalizer log",
        )


# --- from_template lifecycle tests ----------------------------------------


def test_from_template_enter_failure_propagates():
    """If create_sandbox fails inside __enter__, the exception propagates.

    Pins the current behavior so a refactor that silently swallows the
    failure won't slip through. The factory wrapper has its own
    finalizer-based cleanup, but a user using `from_template()` directly
    inside a `with` block expects an exception when provisioning fails.
    """
    mock_sdk = MagicMock()
    mock_sdk.create_sandbox.side_effect = RuntimeError("template not found")

    backend = AgentSandboxBackend(
        sandbox=None,  # type: ignore[arg-type]
        manage_lifecycle=True,
        sdk_client=mock_sdk,
        _template="missing",
        _namespace="default",
    )

    try:
        backend.__enter__()
    except RuntimeError as e:
        _require("template not found" in str(e), f"Unexpected message: {e}")
    else:
        pytest.fail("Expected RuntimeError to propagate from __enter__")

    # _sandbox should still be None — nothing was provisioned, so
    # nothing should be torn down. A subsequent __exit__ on this
    # backend (e.g. from a `with` block that caught the error) must
    # be a no-op.
    _require(backend._sandbox is None, "Expected _sandbox to remain None")
    backend.__exit__(RuntimeError, RuntimeError("test"), None)
    mock_sdk.delete_sandbox.assert_not_called()


def test_exit_does_not_delete_when_manage_lifecycle_false():
    """`manage_lifecycle=False` opts out of automatic cleanup on __exit__.

    This is the contract for users who want to attach an existing
    Sandbox handle and manage its lifecycle separately. A regression
    that ignored the flag would surprise-delete user-managed sandboxes.
    """
    mock_sdk = MagicMock()
    sandbox = StubSandbox()
    sandbox.claim_name = "user-managed-claim"

    backend = AgentSandboxBackend(
        sandbox=sandbox,
        manage_lifecycle=False,
        sdk_client=mock_sdk,
    )

    # Enter the backend (no-op when manage_lifecycle=False — the
    # provided sandbox is used as-is) then exit it.
    backend.__enter__()
    backend.__exit__(None, None, None)

    mock_sdk.delete_sandbox.assert_not_called()


def test_exit_reraises_cleanup_error_on_happy_path():
    """When the user's `with` block exits cleanly, a delete failure must surface.

    Otherwise leaked sandboxes are silent — the user thinks their
    cleanup ran but the controller still has the claim around.
    """
    mock_sdk = MagicMock()
    mock_sdk.delete_sandbox.side_effect = RuntimeError("API unreachable")
    sandbox = StubSandbox()
    sandbox.claim_name = "leaked-claim"

    backend = AgentSandboxBackend(
        sandbox=sandbox,
        manage_lifecycle=True,
        sdk_client=mock_sdk,
    )
    backend.__enter__()

    try:
        backend.__exit__(None, None, None)
    except RuntimeError as e:
        _require("API unreachable" in str(e), f"Unexpected message: {e}")
    else:
        pytest.fail("Expected cleanup RuntimeError to be re-raised on the happy path")


def test_exit_warns_when_cleanup_fails_with_traceback_only_unwind():
    """When __exit__ is called with exc=None but exc_type set (tb-only path),
    cleanup failure surfaces as a ResourceWarning rather than raising.

    Edge case: some context-manager invocations pass `(exc_type, None, tb)`
    when the exception value has been consumed. ExceptionGroup needs a
    real exception instance, so we fall back to a ResourceWarning to
    keep the leak visible to operators.
    """
    import warnings

    mock_sdk = MagicMock()
    mock_sdk.delete_sandbox.side_effect = RuntimeError("teardown also broken")
    sandbox = StubSandbox()
    sandbox.claim_name = "leaked-claim"

    backend = AgentSandboxBackend(
        sandbox=sandbox,
        manage_lifecycle=True,
        sdk_client=mock_sdk,
    )
    backend.__enter__()

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        backend.__exit__(ValueError, None, None)

    _require(
        any(issubclass(w.category, ResourceWarning) for w in caught),
        f"Expected ResourceWarning for tb-only unwind, got: {[w.category for w in caught]}",
    )
    mock_sdk.delete_sandbox.assert_called_once()


# --- Policy wrapper tests ---


def test_policy_wrapper_blocks_denied_paths():
    """Test that write/edit are blocked on denied path prefixes."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(
        backend,
        deny_prefixes=["/etc", "/sys"],
    )

    # Write to denied path
    result = wrapped.write("/etc/passwd", "bad content")
    _require(result.error is not None, "Expected write to be denied")
    _require("Policy denied" in result.error, f"Unexpected error: {result.error}")

    # Edit on denied path
    result = wrapped.edit("/sys/kernel/config", "old", "new")
    _require(result.error is not None, "Expected edit to be denied")
    _require("Policy denied" in result.error, f"Unexpected error: {result.error}")


def test_policy_wrapper_canonicalizes_denied_paths():
    """Policy checks should block normalized traversal paths like /app/../etc."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(backend, deny_prefixes=["/etc"])

    result = wrapped.write("/app/../etc/passwd", "bad content")
    _require(result.error is not None, "Expected write to be denied")
    _require("Policy denied" in result.error, f"Unexpected error: {result.error}")

    responses = wrapped.upload_files({"/app/../etc/shadow": b"bad"})
    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error == "policy_denied", f"Expected policy_denied, got {responses[0].error}")


def test_policy_wrapper_write_resolution_distinguishes_absolute_and_relative_prefixes():
    """With absolute write mode enabled, /etc policy should not block relative etc/* under root_dir."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app", allow_absolute_paths=True)
    backend._exists = lambda _: False
    backend._ensure_parent_dir = lambda _: None
    backend._upload_bytes = lambda _path, _content: None
    wrapped = SandboxPolicyWrapper(backend, deny_prefixes=["/etc"])

    relative_result = wrapped.write("etc/config.txt", "safe")
    _require(relative_result.error is None, f"Unexpected relative-path deny: {relative_result.error}")

    absolute_result = wrapped.write("/etc/passwd", "bad")
    _require(absolute_result.error is not None, "Expected absolute /etc write to be denied")
    _require("Policy denied" in absolute_result.error, f"Unexpected error: {absolute_result.error}")


def test_policy_wrapper_blocks_denied_commands():
    """Test that execute is blocked on denied command patterns."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(
        backend,
        deny_commands=["rm -rf", "shutdown", "reboot"],
    )

    result = wrapped.execute("rm -rf /")
    _require(result.exit_code == 1, "Expected command to fail")
    _require("Policy denied" in result.output, f"Unexpected output: {result.output}")

    result = wrapped.execute("sudo shutdown now")
    _require(result.exit_code == 1, "Expected command to fail")
    _require("Policy denied" in result.output, f"Unexpected output: {result.output}")


def test_policy_wrapper_passes_allowed_operations():
    """Test that non-denied operations work through the wrapper."""
    client = StubSandbox(
        run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0),
        read_bytes=b"file content",
    )
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: False  # For write test
    backend._ensure_parent_dir = lambda _: None
    backend._upload_bytes = lambda path, content: None

    wrapped = SandboxPolicyWrapper(
        backend,
        deny_prefixes=["/etc"],
        deny_commands=["rm -rf"],
    )

    # Allowed command should work
    result = wrapped.execute("echo hello")
    _require(result.exit_code == 0, "Expected command to succeed")
    _require(result.output == "ok", f"Unexpected output: {result.output}")

    # Write to allowed path should work
    result = wrapped.write("/app/file.txt", "content")
    _require(result.error is None, f"Unexpected error: {result.error}")


def test_policy_wrapper_audit_log_called():
    """Test that audit callback is invoked for operations."""
    audit_calls = []

    def audit_log(operation: str, target: str, meta: dict):
        audit_calls.append((operation, target, meta))

    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: False
    backend._ensure_parent_dir = lambda _: None
    backend._upload_bytes = lambda path, content: None

    wrapped = SandboxPolicyWrapper(backend, audit_log=audit_log)

    # Execute should be logged
    wrapped.execute("echo test")
    _require(len(audit_calls) == 1, f"Expected 1 audit call, got {len(audit_calls)}")
    _require(audit_calls[0][0] == "execute", f"Expected execute, got {audit_calls[0][0]}")
    _require(audit_calls[0][1] == "echo test", f"Unexpected target: {audit_calls[0][1]}")

    # Write should be logged
    wrapped.write("/app/file.txt", "hello")
    _require(len(audit_calls) == 2, f"Expected 2 audit calls, got {len(audit_calls)}")
    _require(audit_calls[1][0] == "write", f"Expected write, got {audit_calls[1][0]}")
    _require(audit_calls[1][2]["size"] == 5, f"Expected size 5, got {audit_calls[1][2]}")


def test_policy_wrapper_upload_files_filters_denied():
    """Test that upload_files filters out denied paths."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "missing"
    backend._dir_state = lambda _: "writable"
    backend._upload_bytes = lambda path, content: None

    wrapped = SandboxPolicyWrapper(backend, deny_prefixes=["/etc"])

    responses = wrapped.upload_files({
        "/etc/passwd": b"bad",
        "/app/good.txt": b"good",
    })

    # Should have 2 responses
    _require(len(responses) == 2, f"Expected 2 responses, got {len(responses)}")

    # Find the denied one
    denied = [r for r in responses if r.path == "/etc/passwd"]
    _require(len(denied) == 1, "Expected denied response for /etc/passwd")
    _require(denied[0].error == "policy_denied", f"Expected policy_denied, got {denied[0].error}")


def test_policy_wrapper_read_operations_pass_through():
    """Test that read operations pass through without policy checks."""
    grep_output = "/app/test.py:10:def foo():\n"
    client = StubSandbox(
        run_result=SimpleNamespace(stdout=grep_output, stderr="", exit_code=0),
        read_bytes=b"content",
    )
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    # Even with very restrictive policies, reads should work
    wrapped = SandboxPolicyWrapper(
        backend,
        deny_prefixes=["/"],  # Would block everything if applied to reads
        deny_commands=["grep"],  # grep is used internally
    )

    # grep should still work
    result = wrapped.grep("foo", path="/")
    _require(result.error is None, f"Expected no error, got {result.error}")
    _require(isinstance(result.matches, list), "Expected list of matches")


def test_policy_wrapper_context_manager():
    """Test that policy wrapper works as context manager."""
    # Use MagicMock for context manager support
    mock_sandbox = MagicMock()
    mock_sdk_client = MagicMock()
    mock_sdk_client.create_sandbox.return_value = mock_sandbox

    backend = AgentSandboxBackend(
        sandbox=None,
        manage_lifecycle=True,
        sdk_client=mock_sdk_client,
        _template="test",
        _namespace="default",
    )
    wrapped = SandboxPolicyWrapper(backend)

    with wrapped:
        mock_sdk_client.create_sandbox.assert_called_once()

    mock_sdk_client.delete_sandbox.assert_called_once()


# --- WarmPool backend tests ---


def test_warmpool_backend_from_warmpool():
    """Test WarmPoolBackend.from_warmpool creates backend correctly."""
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance

        backend = WarmPoolBackend.from_warmpool(
            template_name="fast-template",
            namespace="prod",
            warmpool_name="my-warmpool",
        )

        _require(isinstance(backend, WarmPoolBackend), "Should be WarmPoolBackend")
        _require(isinstance(backend, AgentSandboxBackend), "Should also be AgentSandboxBackend")
        _require(backend._template == "fast-template", "Expected _template=fast-template")
        _require(backend._namespace == "prod", "Expected _namespace=prod")
        MockClient.assert_called_once()


def test_warmpool_backend_get_adoption_info():
    """Test get_adoption_info returns warmpool metadata."""
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance

        # With warmpool name
        backend = WarmPoolBackend.from_warmpool(
            template_name="template",
            warmpool_name="pool-1",
        )
        info = backend.get_adoption_info()
        _require(info["warmpool_name"] == "pool-1", f"Expected pool-1, got {info['warmpool_name']}")
        _require(info["from_warmpool"] is True, "Expected from_warmpool=True")

        # Without warmpool name
        backend2 = WarmPoolBackend.from_warmpool(template_name="template")
        info2 = backend2.get_adoption_info()
        _require(info2["warmpool_name"] is None, f"Expected None, got {info2['warmpool_name']}")
        _require(info2["from_warmpool"] is False, "Expected from_warmpool=False")


def test_warmpool_backend_inherits_all_methods():
    """Test WarmPoolBackend inherits all AgentSandboxBackend methods."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = WarmPoolBackend(client)

    # Should have all the standard methods
    _require(hasattr(backend, "execute"), "Should have execute")
    _require(hasattr(backend, "read"), "Should have read")
    _require(hasattr(backend, "write"), "Should have write")
    _require(hasattr(backend, "edit"), "Should have edit")
    _require(hasattr(backend, "ls"), "Should have ls")
    _require(hasattr(backend, "grep"), "Should have grep")
    _require(hasattr(backend, "glob"), "Should have glob")

    # Execute should work
    result = backend.execute("echo test")
    _require(result.output == "ok", f"Unexpected output: {result.output}")


# --- Additional coverage tests ---


def test_root_dir_must_be_absolute():
    """Test that root_dir validation rejects relative paths."""
    client = StubSandbox()

    with pytest.raises(ValueError) as exc_info:
        AgentSandboxBackend(client, root_dir="relative/path")

    _require("absolute path" in str(exc_info.value), f"Unexpected error: {exc_info.value}")


def test_upload_files_returns_upload_failed_on_exception():
    """Test that upload_files handles exceptions gracefully."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "missing"
    backend._dir_state = lambda _: "writable"
    backend._upload_bytes = lambda path, content: (_ for _ in ()).throw(RuntimeError("write failed"))

    responses = backend.upload_files({"/app/file.txt": b"data"})

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error == "upload_failed", f"Expected upload_failed, got {responses[0].error}")


def test_download_files_returns_download_failed_on_exception():
    """Test that download_files handles exceptions gracefully."""
    client = StubSandbox()
    client.files.read = lambda path, timeout=60: (_ for _ in ()).throw(RuntimeError("read failed"))
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "file"

    responses = backend.download_files(["/app/file.txt"])

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error == "download_failed", f"Expected download_failed, got {responses[0].error}")


@pytest.mark.asyncio
async def test_aexecute_delegates_to_execute():
    """Test that async execute delegates correctly."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="async-ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = await backend.aexecute("echo test")

    _require(result.output == "async-ok", f"Unexpected output: {result.output}")
    _require(result.exit_code == 0, f"Unexpected exit code: {result.exit_code}")


def test_read_with_offset_beyond_file_length():
    """Test read() with offset larger than file length returns an error."""
    client = StubSandbox(read_bytes=b"line1\nline2\nline3")
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    result = backend.read("/file.txt", offset=100, limit=10)

    _require(result.error is not None, "Expected error for offset beyond file length")
    _require("exceeds file length" in result.error, f"Unexpected error: {result.error}")
    _require(result.file_data is None, "Expected file_data to be None on error")


def test_read_with_offset_and_limit():
    """Test read() pagination returns raw content sliced by offset/limit."""
    client = StubSandbox(read_bytes=b"line0\nline1\nline2\nline3\nline4")
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    result = backend.read("/file.txt", offset=1, limit=2)

    _require(result.error is None, f"Unexpected error: {result.error}")
    content = result.file_data["content"]
    _require(result.file_data["encoding"] == "utf-8", "Expected utf-8 encoding")
    # offset=1 means start at line index 1 (2nd line), get 2 lines — raw, unnumbered.
    _require(content == "line1\nline2", f"Unexpected content: {content!r}")


def test_edit_string_not_found_returns_error():
    """Test edit() when old_string is not found."""
    client = StubSandbox(read_bytes=b"hello world")
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    result = backend.edit("/file.txt", "missing", "replacement")

    _require(result.error is not None, "Expected error for missing string")
    _require("not found" in result.error, f"Unexpected error: {result.error}")
    _require(result.occurrences == 0, f"Expected 0 occurrences, got {result.occurrences}")


def test_id_property_returns_claim_name_when_available():
    """Test id property returns claim_name when available."""
    sandbox = StubSandbox()
    sandbox.claim_name = "my-claim"
    backend = AgentSandboxBackend(sandbox)

    _require(backend.id == "my-claim", f"Expected my-claim, got {backend.id}")


def test_id_property_returns_sandbox_id_when_no_claim():
    """Test id property returns sandbox_id when no claim_name."""
    sandbox = StubSandbox()
    sandbox.sandbox_id = "my-sandbox"
    backend = AgentSandboxBackend(sandbox)

    _require(backend.id == "my-sandbox", f"Expected my-sandbox, got {backend.id}")


def test_id_property_returns_default_when_no_names():
    """Test id property returns default when no names available."""
    sandbox = StubSandbox()
    backend = AgentSandboxBackend(sandbox)

    _require(backend.id == "agent-sandbox", f"Expected agent-sandbox, got {backend.id}")


def test_grep_ignores_malformed_lines():
    """Test grep handles malformed output lines gracefully."""
    # Mix of valid and malformed lines
    grep_output = "/app/file.py:10:valid match\nmalformed line without colons\n/app/file.py:invalid:line number\n"
    client = StubSandbox(run_result=SimpleNamespace(stdout=grep_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True

    result = backend.grep("valid", path="/")

    # Should only get the one valid match
    _require(result.error is None, f"Unexpected error: {result.error}")
    matches = result.matches
    _require(len(matches) == 1, f"Expected 1 match, got {len(matches)}")
    _require(matches[0]["text"] == "valid match", f"Unexpected text: {matches[0]['text']}")


@pytest.mark.asyncio
async def test_policy_wrapper_async_write_enforces_policy():
    """Test that async write operations enforce policy."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(backend, deny_prefixes=["/etc"])

    result = await wrapped.awrite("/etc/passwd", "bad content")

    _require(result.error is not None, "Expected write to be denied")
    _require("Policy denied" in result.error, f"Unexpected error: {result.error}")


@pytest.mark.asyncio
async def test_policy_wrapper_async_execute_enforces_policy():
    """Test that async execute operations enforce policy."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(backend, deny_commands=["rm -rf"])

    result = await wrapped.aexecute("rm -rf /")

    _require(result.exit_code == 1, "Expected command to fail")
    _require("Policy denied" in result.output, f"Unexpected output: {result.output}")


# --- Additional tests for PR review coverage ---


def test_from_template_creates_managed_backend():
    """Test from_template creates backend with manage_lifecycle=True."""
    with patch("langchain_agent_sandbox.backend.SandboxClient") as MockClient:
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance

        backend = AgentSandboxBackend.from_template(
            template_name="test-template",
            namespace="test-ns",
            gateway_name="my-gateway",
            root_dir="/workspace",
            allow_absolute_paths=True,
        )

        # Verify manage_lifecycle is True
        _require(backend._manage_lifecycle is True, "Expected manage_lifecycle=True")
        _require(backend._root_dir == "/workspace", f"Expected /workspace, got {backend._root_dir}")
        _require(backend._allow_absolute_paths is True, "Expected allow_absolute_paths=True")
        _require(backend._template == "test-template", "Expected _template=test-template")
        _require(backend._namespace == "test-ns", "Expected _namespace=test-ns")

        # Verify SandboxClient was called with a GatewayConnectionConfig
        call_kwargs = MockClient.call_args.kwargs
        _require("connection_config" in call_kwargs, "Expected connection_config kwarg")


def test_upload_bytes_uses_router_upload_endpoint():
    """Test _upload_bytes sends multipart upload with full internal path."""
    sandbox = StubSandbox()
    backend = AgentSandboxBackend(sandbox)

    backend._upload_bytes("/tmp/file.txt", b"content")

    requests = sandbox.connector.requests
    _require(len(requests) == 1, f"Expected 1 request, got {len(requests)}")
    method, endpoint, kwargs = requests[0]
    _require(method == "POST", f"Expected POST, got {method}")
    _require(endpoint == "upload", f"Expected upload endpoint, got {endpoint}")
    _require(kwargs.get("timeout") == 60, f"Expected timeout=60, got {kwargs.get('timeout')}")
    files = kwargs.get("files", {})
    _require("file" in files, f"Expected file in multipart payload, got {files}")
    uploaded_path, uploaded_content = files["file"]
    _require(uploaded_path == "/tmp/file.txt", f"Unexpected upload path: {uploaded_path}")
    _require(uploaded_content == b"content", f"Unexpected upload content: {uploaded_content}")


def test_upload_bytes_raises_with_details():
    """Test _upload_bytes wraps request errors with path details."""
    sandbox = StubSandbox()
    sandbox.connector.send_request = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("Permission denied"))
    backend = AgentSandboxBackend(sandbox)

    with pytest.raises(RuntimeError) as exc_info:
        backend._upload_bytes("/app/file.txt", b"content")

    _require("Upload failed" in str(exc_info.value), f"Unexpected error: {exc_info.value}")
    _require("Permission denied" in str(exc_info.value), f"Expected request error in message: {exc_info.value}")


def test_edit_nonexistent_file_returns_error():
    """Test edit() returns error when file doesn't exist."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: False

    result = backend.edit("/nonexistent.txt", "old", "new")

    _require(result.error is not None, "Expected error for non-existent file")
    _require("not found" in result.error, f"Unexpected error: {result.error}")
    _require(result.path == "/nonexistent.txt", f"Unexpected path: {result.path}")
    _require(result.occurrences == 0, f"Expected 0 occurrences, got {result.occurrences}")


def test_download_files_directory_returns_error():
    """Test download_files returns is_directory error for directories."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "dir"

    responses = backend.download_files(["/app/somedir"])

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error == "is_directory", f"Expected is_directory, got {responses[0].error}")
    _require(responses[0].content is None, "Expected content to be None")


def test_upload_files_existing_directory_returns_error():
    """Test upload_files returns is_directory error when target is a directory."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "dir"

    responses = backend.upload_files({"/app/somedir": b"data"})

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error == "is_directory", f"Expected is_directory, got {responses[0].error}")


def test_upload_files_permission_denied_file():
    """Test upload_files returns permission_denied for unreadable target."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "denied"

    responses = backend.upload_files({"/app/restricted": b"data"})

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(responses[0].error == "permission_denied", f"Expected permission_denied, got {responses[0].error}")


def test_audit_log_exception_does_not_block_operation():
    """Default fail-open behavior: failing audit log doesn't prevent operation."""
    def failing_audit_log(operation: str, target: str, meta: dict):
        raise Exception("Audit service unavailable")

    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(backend, audit_log=failing_audit_log)

    # Execute should still work despite audit log failure
    result = wrapped.execute("echo test")
    _require(result.exit_code == 0, "Expected command to succeed despite audit failure")
    _require(result.output == "ok", f"Unexpected output: {result.output}")


def test_strict_audit_blocks_execute_when_audit_log_fails():
    """strict_audit=True: a failing audit log refuses execute()."""
    def failing_audit_log(operation: str, target: str, meta: dict):
        raise RuntimeError("SIEM unreachable")

    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(
        backend, audit_log=failing_audit_log, strict_audit=True,
    )

    result = wrapped.execute("echo test")

    _require(result.exit_code == 1, "Expected command to be refused")
    _require(
        "Audit log unavailable" in result.output,
        f"Expected refusal message, got: {result.output!r}",
    )
    # The underlying backend.execute should NOT have been called.
    _require(
        client.commands.last_command is None,
        "Backend execute must not run when audit fails in strict mode",
    )


def test_strict_audit_blocks_write_when_audit_log_fails():
    """strict_audit=True: a failing audit log refuses write()."""
    def failing_audit_log(operation: str, target: str, meta: dict):
        raise RuntimeError("SIEM unreachable")

    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: False
    backend._ensure_parent_dir = lambda _: None
    upload_calls = []
    backend._upload_bytes = lambda path, content: upload_calls.append((path, content))

    wrapped = SandboxPolicyWrapper(
        backend, audit_log=failing_audit_log, strict_audit=True,
    )

    result = wrapped.write("/app/file.txt", "content")

    _require(result.error is not None, "Expected write to be refused")
    _require(
        "Audit log unavailable" in result.error,
        f"Expected refusal message, got: {result.error!r}",
    )
    _require(upload_calls == [], "Backend write must not run when audit fails in strict mode")


def test_strict_audit_blocks_upload_files_when_audit_log_fails():
    """strict_audit=True: a failing audit log refuses upload_files entries."""
    def failing_audit_log(operation: str, target: str, meta: dict):
        raise RuntimeError("SIEM unreachable")

    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "missing"
    backend._dir_state = lambda _: "writable"
    upload_calls = []
    backend._upload_bytes = lambda path, content: upload_calls.append((path, content))

    wrapped = SandboxPolicyWrapper(
        backend, audit_log=failing_audit_log, strict_audit=True,
    )

    responses = wrapped.upload_files([("/app/file.txt", b"data")])

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(
        responses[0].error is not None and "Audit log unavailable" in responses[0].error,
        f"Expected audit-failure deny string, got {responses[0].error!r}",
    )
    _require(upload_calls == [], "Backend upload must not run when audit fails in strict mode")


def test_strict_audit_passes_through_when_audit_log_succeeds():
    """strict_audit=True only blocks on FAILURE — happy path still works."""
    audit_calls = []

    def good_audit_log(operation: str, target: str, meta: dict):
        audit_calls.append((operation, target, meta))

    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(
        backend, audit_log=good_audit_log, strict_audit=True,
    )

    result = wrapped.execute("echo test")

    _require(result.exit_code == 0, "Expected command to succeed")
    _require(len(audit_calls) == 1, f"Expected 1 audit call, got {len(audit_calls)}")
    _require(audit_calls[0][0] == "execute", f"Unexpected operation: {audit_calls[0][0]}")


def test_strict_audit_blocks_edit_when_audit_log_fails():
    """strict_audit=True: a failing audit log refuses edit().

    Pins parity with execute/write/upload — without this test, a
    refactor that drops the deny check from SandboxPolicyWrapper.edit
    would not be caught.
    """
    def failing_audit_log(operation: str, target: str, meta: dict):
        raise RuntimeError("SIEM unreachable")

    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    edit_calls = []
    backend.edit = lambda *a, **kw: edit_calls.append((a, kw))  # type: ignore[assignment]

    wrapped = SandboxPolicyWrapper(
        backend, audit_log=failing_audit_log, strict_audit=True,
    )

    result = wrapped.edit("/app/file.txt", "old", "new", replace_all=False)

    _require(result.error is not None, "Expected edit to be refused")
    _require(
        "Audit log unavailable" in result.error,
        f"Expected refusal message, got: {result.error!r}",
    )
    _require(result.occurrences == 0, "Expected occurrences=0 on refusal")
    _require(edit_calls == [], "Backend edit must not run when audit fails in strict mode")


def test_strict_audit_with_no_audit_log_is_a_noop():
    """strict_audit=True + audit_log=None must NOT refuse operations.

    Strict mode only matters when there's a callback to fail. A
    regression that accidentally treated `audit_log=None` as "no audit
    available, refuse" would break every wrapper that opts into strict
    mode without configuring a callback.
    """
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(
        backend, audit_log=None, strict_audit=True,
    )

    result = wrapped.execute("echo test")

    _require(result.exit_code == 0, f"Expected exit_code=0, got {result.exit_code}")
    _require(result.output == "ok", f"Unexpected output: {result.output!r}")


def test_strict_audit_upload_files_preserves_deny_detail():
    """strict_audit upload must surface the deny string, not 'policy_denied'.

    Pins the consistency fix: write/edit preserve the deny string in
    their error fields, and upload_files used to flatten it to
    'policy_denied'. After the fix, the audit-failure detail
    propagates so callers can distinguish 'audit pipeline down' from
    a deny_prefixes hit.
    """
    def failing_audit_log(operation: str, target: str, meta: dict):
        raise RuntimeError("SIEM unreachable")

    client = StubSandbox()
    backend = AgentSandboxBackend(client)
    backend._file_state = lambda _: "missing"
    backend._dir_state = lambda _: "writable"

    wrapped = SandboxPolicyWrapper(
        backend, audit_log=failing_audit_log, strict_audit=True,
    )

    responses = wrapped.upload_files([("/app/file.txt", b"data")])

    _require(len(responses) == 1, f"Expected 1 response, got {len(responses)}")
    _require(
        responses[0].error is not None and "Audit log unavailable" in responses[0].error,
        f"Expected deny detail in error, got {responses[0].error!r}",
    )
    _require(
        "SIEM unreachable" in responses[0].error,
        f"Expected underlying error in deny string, got {responses[0].error!r}",
    )


@pytest.mark.parametrize(
    "operation,call",
    [
        ("write", lambda w: w.write("/app/x.txt", "data")),
        ("edit", lambda w: w.edit("/app/x.txt", "old", "new", False)),
        (
            "upload",
            lambda w: w.upload_files([("/app/x.txt", b"data")]),
        ),
    ],
)
def test_default_audit_failure_does_not_block_write_edit_upload(operation, call):
    """Fail-open is the default: a failing audit log must not block write/edit/upload.

    Previously only `execute` had explicit fail-open coverage. A
    refactor that accidentally made any of these fail-closed by
    default would slip through. Parametrized over the three remaining
    audited operations.
    """
    audit_attempts = []

    def failing_audit_log(op: str, target: str, meta: dict):
        audit_attempts.append((op, target))
        raise RuntimeError("audit pipe down")

    client = StubSandbox(run_result=SimpleNamespace(stdout="", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    # Stub backend methods so the test exercises the wrapper's
    # decision logic without going through real file ops.
    backend._exists = lambda _: False
    backend._ensure_parent_dir = lambda _: None
    upload_calls = []
    backend._upload_bytes = lambda path, content: upload_calls.append((path, content))
    backend._file_state = lambda _: "missing"
    backend._dir_state = lambda _: "writable"

    # edit() exercises a different code path: stub the underlying
    # backend.edit so we can assert the wrapper called through.
    edit_calls = []
    real_edit = backend.edit
    def stub_edit(*a, **kw):
        edit_calls.append((a, kw))
        return real_edit.__class__  # placeholder; not used
    if operation == "edit":
        from langchain_agent_sandbox.backend import EditResult
        backend.edit = lambda *a, **kw: (  # type: ignore[assignment]
            edit_calls.append((a, kw)) or EditResult(error=None, path=a[0], occurrences=1)
        )

    wrapped = SandboxPolicyWrapper(backend, audit_log=failing_audit_log)

    result = call(wrapped)

    _require(
        len(audit_attempts) >= 1,
        f"Expected audit log to have been invoked, got {audit_attempts}",
    )

    if operation == "upload":
        _require(
            len(result) == 1 and result[0].error is None,
            f"Expected upload to succeed in fail-open mode, got {result}",
        )
        _require(
            len(upload_calls) == 1,
            f"Expected backend upload to run, got {upload_calls}",
        )
    elif operation == "write":
        _require(
            result.error is None,
            f"Expected write to succeed in fail-open mode, got error={result.error!r}",
        )
        _require(
            len(upload_calls) == 1,
            f"Expected backend upload to run, got {upload_calls}",
        )
    elif operation == "edit":
        _require(
            result.error is None,
            f"Expected edit to succeed in fail-open mode, got error={result.error!r}",
        )
        _require(
            len(edit_calls) == 1,
            f"Expected backend edit to run, got {edit_calls}",
        )


def test_exit_logs_cleanup_error_when_masked_by_user_exception(caplog):
    """When a user exception is in flight, the cleanup error must be logged.

    Pins the contract that cleanup failures during exception unwind
    are surfaced via logging — a refactor that dropped the
    `logger.error` call would silently lose the leak signal.
    """
    import logging

    mock_sdk = MagicMock()
    mock_sdk.delete_sandbox.side_effect = RuntimeError("teardown also broken")
    sandbox = StubSandbox()
    sandbox.claim_name = "leaked-claim"

    backend = AgentSandboxBackend(
        sandbox=sandbox,
        manage_lifecycle=True,
        sdk_client=mock_sdk,
    )
    backend.__enter__()

    user_exc = ValueError("the original problem")
    with caplog.at_level(logging.ERROR, logger="langchain_agent_sandbox.backend"):
        # __exit__ on the user-exception path should bundle both via
        # ExceptionGroup and also log. We don't assert no-raise here
        # because the new behavior IS to raise an ExceptionGroup —
        # see test_exit_raises_exception_group_when_cleanup_fails_during_unwind.
        try:
            backend.__exit__(type(user_exc), user_exc, None)
        except BaseExceptionGroup:
            pass

    _require(
        any("Failed to delete sandbox" in r.message for r in caplog.records),
        f"Expected cleanup-failure log on the masked path, got {[r.message for r in caplog.records]}",
    )


def test_exit_raises_exception_group_when_cleanup_fails_during_unwind():
    """Cleanup failure during exception unwind raises BaseExceptionGroup.

    The previous behavior swallowed the cleanup error and re-raised
    only the user exception, hiding the leaked sandbox. The new
    behavior bundles both into an ExceptionGroup so neither is lost.
    """
    mock_sdk = MagicMock()
    mock_sdk.delete_sandbox.side_effect = RuntimeError("teardown also broken")
    sandbox = StubSandbox()
    sandbox.claim_name = "leaked-claim"

    backend = AgentSandboxBackend(
        sandbox=sandbox,
        manage_lifecycle=True,
        sdk_client=mock_sdk,
    )
    backend.__enter__()

    user_exc = ValueError("the original problem")
    try:
        backend.__exit__(type(user_exc), user_exc, None)
    except BaseExceptionGroup as eg:
        # Both exceptions must be present in the group.
        types = {type(e) for e in eg.exceptions}
        _require(
            ValueError in types,
            f"Expected ValueError in ExceptionGroup, got {types}",
        )
        _require(
            RuntimeError in types,
            f"Expected RuntimeError in ExceptionGroup, got {types}",
        )
        # Original user exception should be one of the peers, not chained.
        _require(
            any(e is user_exc for e in eg.exceptions),
            "Original user exception should be a peer in the ExceptionGroup",
        )
    else:
        pytest.fail("Expected BaseExceptionGroup to be raised")


# --- Path traversal, error propagation, and find/grep edge cases ---


def test_to_internal_allows_dotdot_prefix_filenames():
    """Filenames like '..foo' are valid and should not be blocked."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app")

    result = backend._to_internal("..foo")

    _require(result == "/app/..foo", f"Expected /app/..foo, got {result}")


def test_to_internal_still_blocks_traversal():
    """Ensure actual traversal like '../' is still blocked after the ..foo fix."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app")

    with pytest.raises(ValueError):
        backend._to_internal("../etc/passwd")

    with pytest.raises(ValueError):
        backend._to_internal("..")


def test_read_error_propagates_exception_message():
    """read() should include the underlying exception message in its error response."""
    client = StubSandbox()
    client.files.read = lambda path, timeout=60: (_ for _ in ()).throw(
        PermissionError("permission denied")
    )
    backend = AgentSandboxBackend(client)

    response = backend.read("/secret.txt")

    _require(response.error is not None, "Expected error")
    _require("permission denied" in response.error, f"Expected exception message in error, got: {response.error}")
    _require("not found" not in response.error, f"Should not say 'not found' for permission errors: {response.error}")


def test_grep_handles_colons_in_filenames():
    """grep with -Z uses null bytes to separate filenames, handling colons."""
    # Simulate grep -Z output: filename\0line_no:text
    grep_output = "/app/config:prod.yaml\x0015:key: value\n/app/normal.txt\x005:other: match\n"
    client = StubSandbox(run_result=SimpleNamespace(stdout=grep_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.grep("key", path="/")

    _require(result.error is None, f"Unexpected error: {result.error}")
    matches = result.matches
    _require(len(matches) == 2, f"Expected 2 matches, got {len(matches)}")
    _require(matches[0]["path"] == "/config:prod.yaml", f"Unexpected path: {matches[0]['path']}")
    _require(matches[0]["line"] == 15, f"Unexpected line: {matches[0]['line']}")
    _require(matches[0]["text"] == "key: value", f"Unexpected text: {matches[0]['text']}")


def test_grep_fallback_without_null_bytes():
    """grep output without null bytes falls back to colon splitting."""
    grep_output = "/app/file.py:10:def foo():\n"
    client = StubSandbox(run_result=SimpleNamespace(stdout=grep_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.grep("foo", path="/")

    matches = result.matches
    _require(len(matches) == 1, f"Expected 1 match, got {len(matches)}")
    _require(matches[0]["path"] == "/file.py", f"Unexpected path: {matches[0]['path']}")


def test_glob_preserves_matches_on_partial_find_failure():
    """find returning non-zero exit (e.g. permission denied on one dir) should keep valid matches."""
    find_output = "f /app/accessible.py\nd /app/subdir\n"
    client = StubSandbox(
        run_result=SimpleNamespace(
            stdout=find_output,
            stderr="find: '/app/restricted': Permission denied",
            exit_code=1,
        )
    )
    backend = AgentSandboxBackend(client)

    result = backend.glob("*", path="/")

    matches = result.matches
    _require(len(matches) == 2, f"Expected 2 matches from partial results, got {len(matches)}")
    paths = [e["path"] for e in matches]
    _require("/accessible.py" in paths, f"Expected /accessible.py in results: {paths}")
    _require("/subdir" in paths, f"Expected /subdir in results: {paths}")


def test_glob_returns_error_on_total_find_failure():
    """find returning non-zero with no stdout should populate error."""
    client = StubSandbox(
        run_result=SimpleNamespace(
            stdout="",
            stderr="find: '/app/nonexistent': No such file or directory",
            exit_code=1,
        )
    )
    backend = AgentSandboxBackend(client)

    result = backend.glob("*.py", path="/nonexistent")

    _require(result.matches == [], f"Expected empty matches, got {result.matches}")
    _require(result.error is not None, "Expected error to be populated on total failure")
    _require("No such file" in result.error, f"Expected stderr in error, got: {result.error}")


def test_glob_partial_failure_returns_matches_without_error():
    """Partial find failure (some stdout produced) should keep matches, no error."""
    find_output = "f /app/accessible.py\n"
    client = StubSandbox(
        run_result=SimpleNamespace(
            stdout=find_output,
            stderr="find: '/app/restricted': Permission denied",
            exit_code=1,
        )
    )
    backend = AgentSandboxBackend(client)

    result = backend.glob("*.py", path="/")

    _require(result.error is None, f"Expected no error on partial success, got: {result.error}")
    _require(len(result.matches) == 1, f"Expected 1 match, got {len(result.matches)}")


def test_glob_find_command_uses_symlink_follow():
    """find command should use -L to follow symlinks."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    backend.glob("*.py", path="/")

    cmd = client.commands.last_command
    _require("find -L " in cmd, f"Expected 'find -L' in command, got: {cmd}")


def test_to_internal_allows_dotdot_prefix_in_nested_path():
    """Filenames like '..config' inside subdirectories should not be blocked."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app")

    result = backend._to_internal("subdir/..config")

    _require(result == "/app/subdir/..config", f"Expected /app/subdir/..config, got {result}")


def test_to_internal_allows_triple_dot_filename():
    """Triple-dot '...' is a valid filename and should not be blocked."""
    client = StubSandbox()
    backend = AgentSandboxBackend(client, root_dir="/app")

    result = backend._to_internal("...")

    _require(result == "/app/...", f"Expected /app/..., got {result}")


def test_grep_command_includes_z_flag():
    """grep command should include -Z for null-byte filename delimiters."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="", stderr="", exit_code=1))
    backend = AgentSandboxBackend(client)

    backend.grep("pattern", path="/")

    cmd = client.commands.last_command
    _require("-rHnFZ" in cmd, f"Expected -rHnFZ in command, got: {cmd}")


def test_grep_skips_null_line_with_no_colon_in_remainder():
    """grep output with null byte but malformed remainder should be skipped."""
    grep_output = "/app/good.py\x005:match\n/app/bad.py\x00malformed\n"
    client = StubSandbox(run_result=SimpleNamespace(stdout=grep_output, stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    result = backend.grep("match", path="/")

    matches = result.matches
    _require(len(matches) == 1, f"Expected 1 match (malformed skipped), got {len(matches)}")
    _require(matches[0]["path"] == "/good.py", f"Unexpected path: {matches[0]['path']}")


def test_read_missing_file_includes_failed_to_read():
    """read() error format should use 'Failed to read' prefix."""
    client = StubSandbox()
    client.files.read = lambda path, timeout=60: (_ for _ in ()).throw(
        RuntimeError("file not found")
    )
    backend = AgentSandboxBackend(client)

    response = backend.read("/missing.txt")

    _require(response.error is not None, "Expected error")
    _require("Failed to read" in response.error, f"Expected 'Failed to read' in error, got: {response.error}")


# --- Post-review hardening: exception paths, timeout forwarding, encoding ---


def test_ls_handles_sandbox_exception():
    """ls should surface transport errors via LsResult.error, not crash."""
    client = StubSandbox()
    client.commands.run = lambda cmd, **kw: (_ for _ in ()).throw(
        RuntimeError("connection dropped")
    )
    backend = AgentSandboxBackend(client)

    result = backend.ls("/")

    _require(result.error is not None, "Expected error")
    _require(result.entries == [], "Expected empty entries on exception")
    _require("connection dropped" in result.error, f"Expected exception message, got: {result.error}")


def test_grep_handles_sandbox_exception():
    """grep should surface transport errors via GrepResult.error, not crash."""
    client = StubSandbox()
    client.commands.run = lambda cmd, **kw: (_ for _ in ()).throw(
        RuntimeError("connection dropped")
    )
    backend = AgentSandboxBackend(client)

    result = backend.grep("pattern", path="/")

    _require(result.error is not None, "Expected error")
    _require(result.matches == [], "Expected empty matches on exception")
    _require("connection dropped" in result.error, f"Expected exception message, got: {result.error}")


def test_glob_handles_sandbox_exception():
    """glob should surface transport errors via GlobResult.error, not crash."""
    client = StubSandbox()
    client.commands.run = lambda cmd, **kw: (_ for _ in ()).throw(
        RuntimeError("connection dropped")
    )
    backend = AgentSandboxBackend(client)

    result = backend.glob("*.py", path="/")

    _require(result.error is not None, "Expected error")
    _require(result.matches == [], "Expected empty matches on exception")
    _require("connection dropped" in result.error, f"Expected exception message, got: {result.error}")


def test_read_empty_file_with_offset_returns_empty_content():
    """Reading an empty file with any offset should succeed with empty content."""
    client = StubSandbox(read_bytes=b"")
    backend = AgentSandboxBackend(client)

    result = backend.read("/empty.txt", offset=42, limit=10)

    _require(result.error is None, f"Expected success on empty file, got: {result.error}")
    _require(result.file_data is not None, "Expected file_data to be populated")
    _require(result.file_data["content"] == "", f"Expected empty content, got: {result.file_data['content']!r}")
    _require(result.file_data["encoding"] == "utf-8", "Expected utf-8 encoding")


def test_read_offset_equals_line_count_returns_error():
    """Off-by-one boundary: offset equal to line count should error."""
    client = StubSandbox(read_bytes=b"line1\nline2\nline3")
    backend = AgentSandboxBackend(client)

    result = backend.read("/file.txt", offset=3, limit=10)

    _require(result.error is not None, "Expected error at boundary")
    _require("exceeds file length" in result.error, f"Unexpected error: {result.error}")


def test_read_invalid_utf8_returns_error():
    """Non-UTF-8 content should be reported as an error, not silently replaced."""
    # 0xff is not valid UTF-8 and would silently become U+FFFD under errors="replace"
    client = StubSandbox(read_bytes=b"valid\nline\n\xff\xfe invalid")
    backend = AgentSandboxBackend(client)

    result = backend.read("/binary.bin")

    _require(result.error is not None, "Expected error for invalid UTF-8")
    _require("UTF-8" in result.error, f"Expected UTF-8 mention in error, got: {result.error}")
    _require(result.file_data is None, "Expected no file_data on decode error")


def test_edit_invalid_utf8_returns_error_without_writing():
    """edit() on a non-UTF-8 file should error before any write, preventing corruption."""
    client = StubSandbox(read_bytes=b"\xff\xfe not utf-8")
    backend = AgentSandboxBackend(client)
    backend._exists = lambda _: True
    uploaded = []
    backend._upload_bytes = lambda path, content: uploaded.append((path, content))

    result = backend.edit("/binary.bin", "foo", "bar")

    _require(result.error is not None, "Expected error for invalid UTF-8")
    _require("UTF-8" in result.error, f"Expected UTF-8 mention in error, got: {result.error}")
    _require(uploaded == [], f"Edit must not write when decode fails, got uploads: {uploaded}")


def test_execute_forwards_timeout_when_provided():
    """execute(timeout=N) must pass timeout kwarg to the sandbox command runner."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    backend.execute("echo test", timeout=30)

    _require(
        client.commands.last_kwargs.get("timeout") == 30,
        f"Expected timeout=30 forwarded, got kwargs: {client.commands.last_kwargs}",
    )


def test_execute_omits_timeout_kwarg_when_none():
    """execute() without timeout must NOT pass the kwarg (use sandbox default)."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    backend.execute("echo test")

    _require(
        "timeout" not in client.commands.last_kwargs,
        f"Expected no timeout kwarg, got: {client.commands.last_kwargs}",
    )


def test_execute_returns_timeout_exit_code_on_builtin_timeout_error():
    """execute() should return exit_code=-2 on a direct Python TimeoutError."""
    client = StubSandbox()
    client.commands.run = lambda cmd, **kw: (_ for _ in ()).throw(
        TimeoutError("command exceeded 5s")
    )
    backend = AgentSandboxBackend(client)

    result = backend.execute("sleep 10", timeout=5)

    _require(result.exit_code == -2, f"Expected exit_code=-2 on timeout, got {result.exit_code}")
    _require("Timed out" in result.output, f"Expected 'Timed out' prefix, got: {result.output}")
    _require("command exceeded 5s" in result.output, f"Expected original message, got: {result.output}")


def test_execute_returns_timeout_exit_code_on_wrapped_requests_timeout():
    """execute() should detect a requests.exceptions.Timeout buried in the cause chain.

    The k8s_agent_sandbox SDK's connector catches requests.exceptions.Timeout
    and re-raises as SandboxRequestError via `raise ... from e`. A real HTTP
    read timeout therefore arrives at the backend as a RuntimeError subclass
    whose __cause__ is the original Timeout — NOT as a builtin TimeoutError.
    This test simulates that exact shape with a custom wrapper class that
    mirrors SandboxRequestError's inheritance (RuntimeError, not TimeoutError)
    and verifies the cause-chain walker still classifies it as a timeout.
    """
    from requests.exceptions import ReadTimeout

    class _FakeSandboxRequestError(RuntimeError):
        """Stand-in for k8s_agent_sandbox.exceptions.SandboxRequestError."""

    original = ReadTimeout("HTTPConnectionPool(...): Read timed out. (read timeout=5)")
    wrapped = _FakeSandboxRequestError("Failed to communicate with the sandbox at ...")
    wrapped.__cause__ = original

    client = StubSandbox()
    client.commands.run = lambda cmd, **kw: (_ for _ in ()).throw(wrapped)
    backend = AgentSandboxBackend(client)

    result = backend.execute("sleep 10", timeout=5)

    _require(result.exit_code == -2, f"Expected exit_code=-2 on wrapped timeout, got {result.exit_code}")
    _require("Timed out" in result.output, f"Expected 'Timed out' prefix, got: {result.output}")


def test_execute_returns_generic_error_exit_code_on_other_exception():
    """execute() should keep exit_code=-1 for non-timeout exceptions (distinguishable)."""
    client = StubSandbox()
    client.commands.run = lambda cmd, **kw: (_ for _ in ()).throw(RuntimeError("boom"))
    backend = AgentSandboxBackend(client)

    result = backend.execute("echo test")

    _require(result.exit_code == -1, f"Expected exit_code=-1, got {result.exit_code}")
    _require("Error: boom" in result.output, f"Expected 'Error:' prefix, got: {result.output}")


@pytest.mark.asyncio
async def test_aexecute_forwards_timeout():
    """aexecute(timeout=N) must pass the timeout kwarg through."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)

    await backend.aexecute("echo test", timeout=15)

    _require(
        client.commands.last_kwargs.get("timeout") == 15,
        f"Expected timeout=15 forwarded, got kwargs: {client.commands.last_kwargs}",
    )


def test_policy_wrapper_execute_forwards_timeout():
    """SandboxPolicyWrapper.execute must forward timeout to the backend."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(backend)

    wrapped.execute("echo test", timeout=45)

    _require(
        client.commands.last_kwargs.get("timeout") == 45,
        f"Expected timeout=45 forwarded through wrapper, got: {client.commands.last_kwargs}",
    )


@pytest.mark.asyncio
async def test_policy_wrapper_aexecute_forwards_timeout():
    """SandboxPolicyWrapper.aexecute must forward timeout to the backend."""
    client = StubSandbox(run_result=SimpleNamespace(stdout="ok", stderr="", exit_code=0))
    backend = AgentSandboxBackend(client)
    wrapped = SandboxPolicyWrapper(backend)

    await wrapped.aexecute("echo test", timeout=60)

    _require(
        client.commands.last_kwargs.get("timeout") == 60,
        f"Expected timeout=60 forwarded through async wrapper, got: {client.commands.last_kwargs}",
    )
