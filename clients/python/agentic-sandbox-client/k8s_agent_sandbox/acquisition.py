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

"""Result types for deterministic SandboxClaim acquisition."""

from dataclasses import dataclass
from typing import Generic, TypeVar


SandboxT = TypeVar("SandboxT")


@dataclass(frozen=True)
class SandboxAcquisition(Generic[SandboxT]):
    """A sandbox handle plus the outcome of atomic Claim acquisition."""

    sandbox: SandboxT
    created: bool
    claim_name: str
    sandbox_id: str
    namespace: str


def merge_claim_labels(
    labels: dict[str, str] | None,
    required_labels: dict[str, str] | None,
) -> dict[str, str] | None:
    """Merge creation labels while refusing conflicting required labels."""
    if not labels and not required_labels:
        return None
    merged = dict(labels or {})
    for key, value in (required_labels or {}).items():
        existing = merged.get(key)
        if existing is not None and existing != value:
            raise ValueError(
                f"Claim label {key!r} conflicts with its required value"
            )
        merged[key] = value
    return merged


def validate_existing_claim(
    claim: dict,
    *,
    claim_name: str,
    namespace: str,
    warmpool: str,
    required_labels: dict[str, str] | None,
) -> None:
    """Fail closed when an existing Claim is not the requested session."""
    existing_warmpool = (
        claim.get("spec", {}).get("warmPoolRef", {}).get("name")
    )
    if existing_warmpool != warmpool:
        raise ValueError(
            f"SandboxClaim {claim_name!r} in namespace {namespace!r} references "
            f"warmpool {existing_warmpool!r}, not {warmpool!r}"
        )

    existing_labels = claim.get("metadata", {}).get("labels", {}) or {}
    mismatches = {
        key: value
        for key, value in (required_labels or {}).items()
        if existing_labels.get(key) != value
    }
    if mismatches:
        keys = ", ".join(sorted(mismatches))
        raise ValueError(
            f"SandboxClaim {claim_name!r} in namespace {namespace!r} does not "
            f"match required ownership labels: {keys}"
        )
