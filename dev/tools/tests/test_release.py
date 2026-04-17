from conftest import load_tool_module


def test_dashboard_manifest_is_split_out_of_release_assets():
    module = load_tool_module("release")

    manifest_files, extension_files, dashboard_files = module.classify_release_yaml_files([
        "k8s/controller.yaml",
        "k8s/dashboard.yaml",
        "k8s/extensions.yaml",
        "k8s/crds/agents.x-k8s.io_sandboxes.yaml",
    ])

    assert dashboard_files == ["k8s/dashboard.yaml"]
    assert extension_files == ["k8s/extensions.yaml"]
    assert "k8s/dashboard.yaml" not in manifest_files
    assert manifest_files == [
        "k8s/controller.yaml",
        "k8s/crds/agents.x-k8s.io_sandboxes.yaml",
    ]
