# Copyright 2026 The Kubernetes Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

# Runtime image for the LangChain DeepAgents sandbox. Mirrors the protocol
# of python-runtime-sandbox (/execute, /upload, /download, /list, /exists)
# but the base directory is taken from the container's WORKDIR rather than
# being hardcoded — so a downstream consumer can pick a different root by
# changing WORKDIR (or SANDBOX_RUNTIME_DIR) without forking the source.
#
# Default WORKDIR is /workspace because that's the conventional working
# directory deepagents tools target ("write your output to /workspace/...").

FROM python:3.12-slim

# ripgrep + git are surfaced via shell commands that deepagents tools
# routinely run (grep / read-large-file / project-search). Keeping them
# in the image avoids the cold-start cost of installing them on every
# sandbox spin-up.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ripgrep \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY requirements.txt .

RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY main.py .

# Non-root execution. UID 1000 matches the SandboxTemplate's
# securityContext defaults so the runtime can read/write its WORKDIR.
RUN chown -R 1000:1000 /workspace

USER 1000

EXPOSE 8888

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8888", "--log-level", "info"]
