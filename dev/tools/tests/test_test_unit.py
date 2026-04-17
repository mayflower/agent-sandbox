from types import SimpleNamespace

from conftest import load_tool_module


def test_dashboard_tests_are_scheduled_when_dependencies_exist(tmp_path, monkeypatch):
    module = load_tool_module("test-unit")
    dashboard_dir = tmp_path / "dashboard"
    dashboard_dir.mkdir()
    (dashboard_dir / "package.json").write_text("{}", encoding="utf-8")
    (dashboard_dir / "node_modules").mkdir()

    calls = []

    def fake_run(cmd, cwd):
        calls.append((cmd, cwd))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/npm" if name == "npm" else None)
    monkeypatch.setattr(module.subprocess, "run", fake_run)

    assert module.run_dashboard_tests(str(tmp_path)) == 0
    assert calls == [
        (["npm", "run", "test:ci"], str(dashboard_dir)),
    ]


def test_dashboard_tests_are_skipped_when_workspace_is_missing(tmp_path):
    module = load_tool_module("test-unit")

    assert module.run_dashboard_tests(str(tmp_path)) == 0


def test_dashboard_failure_code_is_propagated(tmp_path, monkeypatch):
    module = load_tool_module("test-unit")
    dashboard_dir = tmp_path / "dashboard"
    dashboard_dir.mkdir()
    (dashboard_dir / "package.json").write_text("{}", encoding="utf-8")
    (dashboard_dir / "node_modules").mkdir()

    responses = iter([SimpleNamespace(returncode=7)])

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/npm" if name == "npm" else None)
    monkeypatch.setattr(module.subprocess, "run", lambda cmd, cwd: next(responses))

    assert module.run_dashboard_tests(str(tmp_path)) == 7


def test_dashboard_tests_fail_fast_when_dependencies_are_missing(tmp_path, monkeypatch):
    module = load_tool_module("test-unit")
    dashboard_dir = tmp_path / "dashboard"
    dashboard_dir.mkdir()
    (dashboard_dir / "package.json").write_text("{}", encoding="utf-8")
    (dashboard_dir / "package-lock.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/npm" if name == "npm" else None)

    assert module.run_dashboard_tests(str(tmp_path)) == 1
