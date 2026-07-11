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

import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timezone
from threading import Barrier, Lock
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from kubernetes.client.exceptions import ApiException

pytest.importorskip("kubernetes_asyncio")

from kubernetes_asyncio.client.exceptions import ApiException as AsyncApiException

from k8s_agent_sandbox.async_sandbox_client import AsyncSandboxClient
from k8s_agent_sandbox.exceptions import SandboxNotFoundError
from k8s_agent_sandbox.models import SandboxDirectConnectionConfig
from k8s_agent_sandbox.sandbox_client import SandboxClient
from k8s_agent_sandbox.utils import validate_claim_name


def _claim(
    *,
    warmpool: str = "python-pool",
    labels: dict[str, str] | None = None,
) -> dict:
    return {
        "metadata": {"name": "session-claim", "labels": labels or {}},
        "spec": {"warmPoolRef": {"name": warmpool}},
    }


class TestClaimNameValidation(unittest.TestCase):
    def test_accepts_dns_1123_label(self):
        self.assertEqual(validate_claim_name("mas-abc123"), "mas-abc123")

    def test_rejects_invalid_values(self):
        invalid = ["", "Uppercase", "starts-", "-starts", "has.dot", "a" * 64]
        for claim_name in invalid:
            with self.subTest(claim_name=claim_name), self.assertRaises(ValueError):
                validate_claim_name(claim_name)


class TestSandboxSessionAcquisition(unittest.TestCase):
    def setUp(self):
        helper_patcher = patch("k8s_agent_sandbox.sandbox_client.K8sHelper")
        self.addCleanup(helper_patcher.stop)
        helper_patcher.start()
        self.client = SandboxClient()
        self.helper = self.client.k8s_helper

    def test_create_uses_caller_supplied_claim_name(self):
        self.helper.resolve_sandbox_name.return_value = "sandbox-id"
        sandbox = MagicMock(sandbox_id="sandbox-id")
        self.client.sandbox_class = MagicMock(return_value=sandbox)

        with patch.object(self.client, "_create_claim") as create_claim, patch.object(
            self.client, "_wait_for_sandbox_ready"
        ):
            result = self.client.create_sandbox(
                "python-pool", claim_name="mas-session123"
            )

        self.assertIs(result, sandbox)
        self.assertEqual(create_claim.call_args.args[0], "mas-session123")

    def test_create_conflict_does_not_delete_existing_claim(self):
        with patch.object(
            self.client,
            "_create_claim",
            side_effect=ApiException(status=409, reason="AlreadyExists"),
        ), patch.object(self.client, "_delete_claim") as delete_claim:
            with self.assertRaises(ApiException):
                self.client.create_sandbox(
                    "python-pool", claim_name="mas-session123"
                )
        delete_claim.assert_not_called()

    def test_get_or_create_returns_created_acquisition(self):
        self.helper.get_sandbox_claim.return_value = None
        sandbox = MagicMock(sandbox_id="sandbox-id")
        with patch.object(
            self.client, "create_sandbox", return_value=sandbox
        ) as create_sandbox:
            acquisition = self.client.get_or_create_sandbox(
                "python-pool",
                claim_name="mas-session123",
                labels={"app": "worker"},
                required_labels={"sessions.example/key": "opaque"},
            )

        self.assertTrue(acquisition.created)
        self.assertIs(acquisition.sandbox, sandbox)
        self.assertEqual(acquisition.sandbox_id, "sandbox-id")
        self.assertEqual(
            create_sandbox.call_args.args[3],
            {"app": "worker", "sessions.example/key": "opaque"},
        )

    def test_get_or_create_attaches_existing_claim(self):
        self.helper.get_sandbox_claim.return_value = _claim(
            labels={"sessions.example/key": "opaque"}
        )
        sandbox = MagicMock(sandbox_id="winner-id")
        with patch.object(self.client, "get_sandbox", return_value=sandbox):
            acquisition = self.client.get_or_create_sandbox(
                "python-pool",
                claim_name="mas-session123",
                required_labels={"sessions.example/key": "opaque"},
            )

        self.assertFalse(acquisition.created)
        self.assertEqual(acquisition.sandbox_id, "winner-id")

    def test_create_race_attaches_409_winner_without_deleting(self):
        self.helper.get_sandbox_claim.side_effect = [
            None,
            _claim(labels={"sessions.example/key": "opaque"}),
        ]
        winner = MagicMock(sandbox_id="winner-id")
        with patch.object(
            self.client,
            "create_sandbox",
            side_effect=ApiException(status=409, reason="AlreadyExists"),
        ), patch.object(
            self.client, "get_sandbox", return_value=winner
        ), patch.object(self.client, "_delete_claim") as delete_claim:
            acquisition = self.client.get_or_create_sandbox(
                "python-pool",
                claim_name="mas-session123",
                required_labels={"sessions.example/key": "opaque"},
            )

        self.assertFalse(acquisition.created)
        self.assertIs(acquisition.sandbox, winner)
        delete_claim.assert_not_called()

    def test_two_clients_race_to_one_claim(self):
        class SharedHelper:
            def __init__(self):
                self.barrier = Barrier(2)
                self.lock = Lock()
                self.claim = None
                self.initial_reads = 0
                self.delete_count = 0

            def get_sandbox_claim(self, name, namespace):
                with self.lock:
                    self.initial_reads += 1
                    initial_read = self.initial_reads <= 2
                    claim = self.claim
                if initial_read:
                    self.barrier.wait(timeout=2)
                    return None
                return claim

            def create_sandbox_claim(
                self, name, warmpool, namespace, **kwargs
            ):
                with self.lock:
                    if self.claim is not None:
                        raise ApiException(status=409, reason="AlreadyExists")
                    self.claim = _claim(
                        warmpool=warmpool,
                        labels=kwargs.get("labels"),
                    )

            def resolve_sandbox_name(self, name, namespace, timeout):
                return "shared-sandbox"

            def wait_for_sandbox_ready(self, name, namespace, timeout):
                return None

            def get_sandbox(self, name, namespace):
                return {"metadata": {"name": name}}

            def delete_sandbox_claim(self, name, namespace):
                self.delete_count += 1

        class Handle:
            def __init__(self, *, claim_name, sandbox_id, namespace, **kwargs):
                self.claim_name = claim_name
                self.sandbox_id = sandbox_id
                self.namespace = namespace
                self.is_active = True

        helper = SharedHelper()
        clients = []
        for _ in range(2):
            with patch("k8s_agent_sandbox.sandbox_client.K8sHelper"):
                client = SandboxClient()
            client.k8s_helper = helper
            client.sandbox_class = Handle
            clients.append(client)

        def acquire(client):
            return client.get_or_create_sandbox(
                "python-pool",
                claim_name="mas-session123",
                required_labels={"sessions.example/key": "opaque"},
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            acquisitions = list(executor.map(acquire, clients))

        self.assertEqual(sorted(item.created for item in acquisitions), [False, True])
        self.assertEqual(
            {item.sandbox_id for item in acquisitions}, {"shared-sandbox"}
        )
        self.assertEqual(helper.delete_count, 0)

    def test_refuses_warmpool_mismatch(self):
        self.helper.get_sandbox_claim.return_value = _claim(warmpool="other-pool")
        with self.assertRaisesRegex(ValueError, "other-pool"):
            self.client.get_or_create_sandbox(
                "python-pool", claim_name="mas-session123"
            )

    def test_refuses_ownership_mismatch(self):
        self.helper.get_sandbox_claim.return_value = _claim(
            labels={"sessions.example/key": "someone-else"}
        )
        with self.assertRaisesRegex(ValueError, "ownership labels"):
            self.client.get_or_create_sandbox(
                "python-pool",
                claim_name="mas-session123",
                required_labels={"sessions.example/key": "opaque"},
            )

    def test_renew_sandbox(self):
        self.helper.get_sandbox_claim.return_value = _claim()

        deadline = self.client.renew_sandbox(
            "mas-session123", "tenant-ns", 300
        )

        self.assertEqual(deadline.tzinfo, timezone.utc)
        lifecycle = self.helper.patch_sandbox_claim.call_args.args[2]["spec"][
            "lifecycle"
        ]
        self.assertEqual(lifecycle["shutdownPolicy"], "DeleteForeground")

    def test_renew_not_found(self):
        self.helper.get_sandbox_claim.return_value = None
        with self.assertRaises(SandboxNotFoundError):
            self.client.renew_sandbox("mas-session123", "tenant-ns", 300)
        self.helper.patch_sandbox_claim.assert_not_called()

    def test_renew_patch_404_is_typed_not_found(self):
        self.helper.get_sandbox_claim.return_value = _claim()
        self.helper.patch_sandbox_claim.side_effect = ApiException(status=404)
        with self.assertRaises(SandboxNotFoundError):
            self.client.renew_sandbox("mas-session123", "tenant-ns", 300)

    def test_renew_validates_duration_and_policy(self):
        for duration, policy in [(0, "DeleteForeground"), (1, "Unknown")]:
            with self.subTest(duration=duration, policy=policy), self.assertRaises(
                ValueError
            ):
                self.client.renew_sandbox(
                    "mas-session123", "tenant-ns", duration, policy
                )


class TestAsyncSandboxSessionAcquisition(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        helper_patcher = patch(
            "k8s_agent_sandbox.async_sandbox_client.AsyncK8sHelper"
        )
        self.addCleanup(helper_patcher.stop)
        helper_patcher.start()
        self.client = AsyncSandboxClient(
            connection_config=SandboxDirectConnectionConfig(
                api_url="http://router:8080"
            ),
            cleanup=False,
        )
        self.helper = self.client.k8s_helper

    async def test_create_uses_caller_supplied_claim_name(self):
        self.helper.resolve_sandbox_name = AsyncMock(return_value="sandbox-id")
        sandbox = MagicMock(sandbox_id="sandbox-id")
        self.client.sandbox_class = MagicMock(return_value=sandbox)
        with patch.object(
            self.client, "_create_claim", new_callable=AsyncMock
        ) as create_claim, patch.object(
            self.client, "_wait_for_sandbox_ready", new_callable=AsyncMock
        ):
            result = await self.client.create_sandbox(
                "python-pool", claim_name="mas-session123"
            )
        self.assertIs(result, sandbox)
        self.assertEqual(create_claim.call_args.args[0], "mas-session123")

    async def test_create_race_attaches_409_winner(self):
        self.helper.get_sandbox_claim = AsyncMock(
            side_effect=[
                None,
                _claim(labels={"sessions.example/key": "opaque"}),
            ]
        )
        winner = MagicMock(sandbox_id="winner-id")
        with patch.object(
            self.client,
            "create_sandbox",
            new_callable=AsyncMock,
            side_effect=AsyncApiException(status=409, reason="AlreadyExists"),
        ), patch.object(
            self.client,
            "get_sandbox",
            new_callable=AsyncMock,
            return_value=winner,
        ), patch.object(
            self.client, "_delete_claim", new_callable=AsyncMock
        ) as delete_claim:
            acquisition = await self.client.get_or_create_sandbox(
                "python-pool",
                claim_name="mas-session123",
                required_labels={"sessions.example/key": "opaque"},
            )

        self.assertFalse(acquisition.created)
        self.assertIs(acquisition.sandbox, winner)
        delete_claim.assert_not_awaited()

    async def test_refuses_warmpool_and_ownership_mismatches(self):
        cases = [
            (_claim(warmpool="other-pool"), None, "other-pool"),
            (
                _claim(labels={"sessions.example/key": "other"}),
                {"sessions.example/key": "opaque"},
                "ownership labels",
            ),
        ]
        for claim, required_labels, message in cases:
            with self.subTest(message=message):
                self.helper.get_sandbox_claim = AsyncMock(return_value=claim)
                with self.assertRaisesRegex(ValueError, message):
                    await self.client.get_or_create_sandbox(
                        "python-pool",
                        claim_name="mas-session123",
                        required_labels=required_labels,
                    )

    async def test_renew_sandbox_and_typed_404(self):
        self.helper.get_sandbox_claim = AsyncMock(return_value=_claim())
        self.helper.patch_sandbox_claim = AsyncMock()
        deadline = await self.client.renew_sandbox(
            "mas-session123", "tenant-ns", 300
        )
        self.assertEqual(deadline.tzinfo, timezone.utc)
        lifecycle = self.helper.patch_sandbox_claim.call_args.args[2]["spec"][
            "lifecycle"
        ]
        self.assertEqual(lifecycle["shutdownPolicy"], "DeleteForeground")

        self.helper.patch_sandbox_claim.side_effect = AsyncApiException(status=404)
        with self.assertRaises(SandboxNotFoundError):
            await self.client.renew_sandbox(
                "mas-session123", "tenant-ns", 300
            )
