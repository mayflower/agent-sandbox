"""In-memory SandboxBackendProtocol fixture for ContextHubSyncedSandboxBackend tests."""

from __future__ import annotations

import posixpath

from deepagents.backends.protocol import (
    EditResult,
    ExecuteResponse,
    FileData,
    FileDownloadResponse,
    FileInfo,
    FileUploadResponse,
    GlobResult,
    GrepMatch,
    GrepResult,
    LsResult,
    ReadResult,
    SandboxBackendProtocol,
    WriteResult,
)


class FakeSandboxBackend(SandboxBackendProtocol):
    def __init__(self, *, backend_id: str = "fake-sandbox") -> None:
        self.files: dict[str, bytes] = {}
        self.backend_id = backend_id
        self.entered = False
        self.exited = False
        self.upload_calls: list[list[tuple[str, bytes]]] = []
        self.write_calls: list[tuple[str, str]] = []
        self.execute_calls: list[tuple[str, int | None]] = []
        self.fail_upload = False
        self.fail_write = False

    @property
    def id(self) -> str:
        return self.backend_id

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.exited = True

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        self.execute_calls.append((command, timeout))
        if command.startswith("cat "):
            path = command.removeprefix("cat ").strip()
            content = self.files.get(path)
            if content is None:
                return ExecuteResponse(output=f"cat: {path}: No such file", exit_code=1, truncated=False)
            return ExecuteResponse(output=content.decode("utf-8"), exit_code=0, truncated=False)
        return ExecuteResponse(output="", exit_code=0, truncated=False)

    def ls(self, path: str) -> LsResult:
        path = _norm(path)
        entries: list[FileInfo] = []
        seen_dirs: set[str] = set()
        prefix = path.rstrip("/") + "/" if path != "/" else "/"
        for file_path, payload in self.files.items():
            if not file_path.startswith(prefix):
                continue
            rest = file_path[len(prefix):]
            if not rest:
                continue
            head, sep, _tail = rest.partition("/")
            public = posixpath.join(path, head) if path != "/" else "/" + head
            if sep:
                if public not in seen_dirs:
                    seen_dirs.add(public)
                    entries.append(FileInfo(path=public, is_dir=True))
            else:
                entries.append(FileInfo(path=public, is_dir=False, size=len(payload)))
        entries.sort(key=lambda x: x["path"])
        return LsResult(entries=entries)

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        file_path = _norm(file_path)
        payload = self.files.get(file_path)
        if payload is None:
            return ReadResult(error=f"File '{file_path}' not found")
        text = payload.decode("utf-8")
        lines = text.splitlines()
        if not lines:
            return ReadResult(file_data=FileData(content="", encoding="utf-8"))
        if offset >= len(lines):
            return ReadResult(error="offset exceeds file length")
        return ReadResult(file_data=FileData(content="\n".join(lines[offset : offset + limit]), encoding="utf-8"))

    def write(self, file_path: str, content: str) -> WriteResult:
        file_path = _norm(file_path)
        self.write_calls.append((file_path, content))
        if self.fail_write:
            return WriteResult(error="fake write failed", path=file_path)
        if file_path in self.files:
            return WriteResult(error=f"File '{file_path}' already exists", path=file_path)
        self.files[file_path] = content.encode("utf-8")
        return WriteResult(path=file_path)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        file_path = _norm(file_path)
        payload = self.files.get(file_path)
        if payload is None:
            return EditResult(error=f"File '{file_path}' not found", occurrences=0)
        text = payload.decode("utf-8")
        count = text.count(old_string)
        if count == 0:
            return EditResult(error="String not found", occurrences=0)
        if count > 1 and not replace_all:
            return EditResult(error="String appears multiple times", occurrences=count)
        updated = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
        self.files[file_path] = updated.encode("utf-8")
        return EditResult(path=file_path, occurrences=count if replace_all else 1)

    def upload_files(self, files: list[tuple[str, bytes]]):
        self.upload_calls.append(list(files))
        responses: list[FileUploadResponse] = []
        for path, payload in files:
            path = _norm(path)
            if self.fail_upload:
                responses.append(FileUploadResponse(path=path, error="upload_failed"))
            else:
                self.files[path] = payload
                responses.append(FileUploadResponse(path=path, error=None))
        return responses

    def download_files(self, paths: list[str]):
        responses: list[FileDownloadResponse] = []
        for path in paths:
            path = _norm(path)
            if path not in self.files:
                responses.append(FileDownloadResponse(path=path, content=None, error="file_not_found"))
            else:
                responses.append(FileDownloadResponse(path=path, content=self.files[path], error=None))
        return responses

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None) -> GrepResult:
        base = _norm(path or "/")
        matches: list[GrepMatch] = []
        for file_path, payload in self.files.items():
            if not file_path.startswith(base.rstrip("/") + "/") and file_path != base:
                continue
            text = payload.decode("utf-8", errors="ignore")
            for line_no, line in enumerate(text.splitlines(), start=1):
                if pattern in line:
                    matches.append(GrepMatch(path=file_path, line=line_no, text=line))
        return GrepResult(matches=matches)

    def glob(self, pattern: str, path: str = "/") -> GlobResult:
        import fnmatch
        base = _norm(path)
        matches: list[FileInfo] = []
        for file_path, payload in self.files.items():
            if not file_path.startswith(base.rstrip("/") + "/") and file_path != base:
                continue
            rel = file_path[len(base.rstrip("/")) + 1:] if base != "/" else file_path.lstrip("/")
            if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(file_path, pattern):
                matches.append(FileInfo(path=file_path, is_dir=False, size=len(payload)))
        return GlobResult(matches=matches)


def _norm(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return posixpath.normpath(path)
