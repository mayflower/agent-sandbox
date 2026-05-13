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

"""LangChain DeepAgents sandbox runtime.

Same HTTP surface as ``examples/python-runtime-sandbox/main.py``
(``/execute``, ``/upload``, ``/download``, ``/list``, ``/exists``)
but the base directory is **not** hardcoded — it's read once at
process start from:

1. ``$SANDBOX_RUNTIME_DIR`` (env var, if set), or
2. ``os.getcwd()`` (the container's ``WORKDIR``).

A downstream image can pick a different root just by changing
``WORKDIR`` (or injecting the env var via Pod spec), without forking
this source.
"""

import logging
import os
import shlex
import subprocess
import urllib.parse

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# Resolved once at startup. ``realpath`` so that any symlink in the
# WORKDIR is collapsed up-front — the path-traversal check below uses
# the same realpath form, so a symlink in the middle of a user path
# can't shadow the prefix comparison.
BASE_DIR = os.path.realpath(
    os.environ.get("SANDBOX_RUNTIME_DIR") or os.getcwd()
)


class ExecuteRequest(BaseModel):
    """Request model for the /execute endpoint."""

    command: str


class ExecuteResponse(BaseModel):
    """Response model for the /execute endpoint."""

    stdout: str
    stderr: str
    exit_code: int


def get_safe_path(file_path: str) -> str:
    """Resolve ``file_path`` against BASE_DIR and refuse anything that escapes it.

    Mirrors the helper of python-runtime-sandbox/main.py but is anchored
    on the runtime-resolved ``BASE_DIR`` instead of a literal ``/app``.
    """
    clean_path = file_path.lstrip("/")
    full_path = os.path.realpath(os.path.join(BASE_DIR, clean_path))
    if os.path.commonpath([BASE_DIR, full_path]) != BASE_DIR:
        raise ValueError(f"Access denied: Path must be within {BASE_DIR}")
    return full_path


app = FastAPI(
    title="LangChain DeepAgents Sandbox Runtime",
    description=(
        "API server for executing commands and managing files in a "
        "sandbox pod. File operations are confined to the resolved "
        "BASE_DIR (default: container WORKDIR)."
    ),
    version="1.0.0",
)


@app.get("/", summary="Health Check")
async def health_check():
    """Liveness + base-dir disclosure for operators."""
    return {
        "status": "ok",
        "message": "Sandbox Runtime is active.",
        "base_dir": BASE_DIR,
    }


@app.post(
    "/execute", summary="Execute a shell command", response_model=ExecuteResponse
)
async def execute_command(request: ExecuteRequest):
    """Run a shell command in the sandbox, with cwd anchored at BASE_DIR."""
    try:
        args = shlex.split(request.command)
        process = subprocess.run(
            args,
            capture_output=True,
            text=True,
            cwd=BASE_DIR,
        )
        return ExecuteResponse(
            stdout=process.stdout,
            stderr=process.stderr,
            exit_code=process.returncode,
        )
    except Exception as e:
        return ExecuteResponse(
            stdout="",
            stderr=f"Failed to execute command: {e}",
            exit_code=1,
        )


@app.post("/upload", summary="Upload a file to the sandbox")
async def upload_file(file: UploadFile = File(...)):
    """Save an uploaded file under BASE_DIR.

    Uses ``get_safe_path`` so a malicious ``filename`` containing ``../``
    cannot escape the sandbox root.
    """
    try:
        logging.info(
            "--- UPLOAD_FILE CALLED: Attempting to save '%s' ---", file.filename
        )
        try:
            file_path = get_safe_path(file.filename or "")
        except ValueError:
            return JSONResponse(status_code=403, content={"message": "Access denied"})

        with open(file_path, "wb") as f:
            f.write(await file.read())

        return JSONResponse(
            status_code=200,
            content={"message": f"File '{file.filename}' uploaded successfully."},
        )
    except Exception as e:
        logging.exception("An error occurred during file upload.")
        return JSONResponse(
            status_code=500,
            content={"message": f"File upload failed: {e}"},
        )


@app.get(
    "/download/{encoded_file_path:path}", summary="Download a file from the sandbox"
)
async def download_file(encoded_file_path: str):
    """Stream a file under BASE_DIR back to the caller."""
    decoded_path = urllib.parse.unquote(encoded_file_path)
    try:
        full_path = get_safe_path(decoded_path)
    except ValueError:
        return JSONResponse(status_code=403, content={"message": "Access denied"})

    if os.path.isfile(full_path):
        return FileResponse(
            path=full_path,
            media_type="application/octet-stream",
            filename=os.path.basename(decoded_path),
        )
    return JSONResponse(status_code=404, content={"message": "File not found"})


@app.get("/list/{encoded_file_path:path}", summary="List files in a directory")
async def list_files(encoded_file_path: str):
    """Return directory entries with size/type/mod_time."""
    decoded_path = urllib.parse.unquote(encoded_file_path)
    try:
        full_path = get_safe_path(decoded_path)
    except ValueError:
        return JSONResponse(status_code=403, content={"message": "Access denied"})

    if not os.path.isdir(full_path):
        return JSONResponse(
            status_code=404, content={"message": "Path is not a directory"}
        )

    try:
        entries = []
        with os.scandir(full_path) as it:
            for entry in it:
                stats = entry.stat()
                entries.append(
                    {
                        "name": entry.name,
                        "size": stats.st_size,
                        "type": "directory" if entry.is_dir() else "file",
                        "mod_time": stats.st_mtime,
                    }
                )
        return JSONResponse(status_code=200, content=entries)
    except Exception as e:
        return JSONResponse(
            status_code=500, content={"message": f"List files failed: {e}"}
        )


@app.get(
    "/exists/{encoded_file_path:path}", summary="Check if a path exists"
)
async def exists(encoded_file_path: str):
    """Report whether ``path`` (under BASE_DIR) resolves to an existing entry."""
    decoded_path = urllib.parse.unquote(encoded_file_path)
    try:
        full_path = get_safe_path(decoded_path)
    except ValueError:
        return JSONResponse(status_code=403, content={"message": "Access denied"})

    return JSONResponse(
        status_code=200,
        content={"path": decoded_path, "exists": os.path.exists(full_path)},
    )
