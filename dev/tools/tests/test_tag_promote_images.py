from conftest import load_tool_module


def test_dashboard_image_is_promoted_with_release_bundle():
    module = load_tool_module("tag-promote-images")

    assert "dashboard" in module.IMAGES_TO_PROMOTE
