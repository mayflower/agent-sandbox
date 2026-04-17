from pathlib import Path

from conftest import load_tool_module


def write_dockerfile(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("FROM scratch\n", encoding="utf-8")


def test_normal_scan_discovers_dashboard_and_controller(tmp_path):
    module = load_tool_module("push-images")
    write_dockerfile(tmp_path / "Dockerfile")
    write_dockerfile(tmp_path / "dashboard" / "Dockerfile")
    write_dockerfile(tmp_path / "examples" / "chrome-sandbox" / "Dockerfile")

    targets = module.discover_docker_build_targets(str(tmp_path))
    service_names = sorted(target.service_name for target in targets)

    assert "agent-sandbox-controller" in service_names
    assert "dashboard" in service_names
    assert "chrome-sandbox" in service_names


def test_controller_only_scan_excludes_dashboard(tmp_path):
    module = load_tool_module("push-images")
    write_dockerfile(tmp_path / "Dockerfile")
    write_dockerfile(tmp_path / "dashboard" / "Dockerfile")
    write_dockerfile(tmp_path / "clients" / "python-runtime-sandbox" / "Dockerfile")

    targets = module.discover_docker_build_targets(str(tmp_path), controller_only=True)
    service_names = sorted(target.service_name for target in targets)

    assert service_names == ["agent-sandbox-controller"]
