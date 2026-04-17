import argparse

from conftest import load_tool_module


def make_doc(name):
    return {
        "doc": {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {"name": name},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {"name": name, "image": f"{name}:latest"},
                        ]
                    }
                }
            },
        },
        "filename": f"{name}.yaml",
        "kind": "Deployment",
    }


def build_args(**overrides):
    values = {
        "image_prefix": "example.registry/",
        "image_tag": "unit-test",
        "extensions": False,
        "dashboard": False,
        "controller_args": "",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def test_dashboard_manifest_is_not_selected_by_default(monkeypatch):
    module = load_tool_module("deploy-to-kube")
    monkeypatch.setattr(module.utils, "get_image_tag", lambda: "unit-test")

    prereq_docs, other_docs, extension_docs = module.process_manifests(
        [make_doc("controller"), make_doc("dashboard")],
        build_args(),
    )

    assert prereq_docs == []
    assert extension_docs == []
    assert [doc["metadata"]["name"] for doc in other_docs] == ["controller"]


def test_dashboard_manifest_is_selected_with_dashboard_flag(monkeypatch):
    module = load_tool_module("deploy-to-kube")
    monkeypatch.setattr(module.utils, "get_image_tag", lambda: "unit-test")

    _prereq_docs, other_docs, _extension_docs = module.process_manifests(
        [make_doc("controller"), make_doc("dashboard")],
        build_args(dashboard=True),
    )

    assert [doc["metadata"]["name"] for doc in other_docs] == ["controller", "dashboard"]


def test_extensions_selection_is_unchanged_when_dashboard_flag_is_off(monkeypatch):
    module = load_tool_module("deploy-to-kube")
    monkeypatch.setattr(module.utils, "get_image_tag", lambda: "unit-test")
    extension_doc = make_doc("extensions")
    extension_doc["filename"] = "extensions.yaml"

    _prereq_docs, other_docs, extension_docs = module.process_manifests(
        [make_doc("controller"), extension_doc, make_doc("dashboard")],
        build_args(extensions=True),
    )

    assert [doc["metadata"]["name"] for doc in other_docs] == ["controller"]
    assert [doc["metadata"]["name"] for doc in extension_docs] == ["extensions"]
