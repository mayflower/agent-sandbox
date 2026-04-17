from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
import sys


TOOLS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = TOOLS_ROOT.parents[1]

if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))


def load_tool_module(filename):
    path = TOOLS_ROOT / filename
    module_name = f"tool_{filename.replace('-', '_')}"
    loader = SourceFileLoader(module_name, str(path))
    spec = spec_from_loader(module_name, loader)
    assert spec is not None
    module = module_from_spec(spec)
    sys.modules[module_name] = module
    loader.exec_module(module)
    return module
