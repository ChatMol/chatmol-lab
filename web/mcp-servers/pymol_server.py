"""
ChatMol Lab bundled MCP server for PyMOL.

Derived from ChatMol/molecule-mcp (MIT). Differences from the upstream script:
- no dependency on the `chatmol` package: PyMOL is launched with `-R` (XML-RPC)
  and driven over localhost directly;
- cross-platform PyMOL discovery (PATH, conda env, macOS/Windows app bundles),
  overridable with CHATMOL_PYMOL_BIN;
- images are returned inline as MCP image content and also written to the
  workspace so the agent can save them as artifacts.

Requires: pip install "mcp>=1.2,<2"
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import time
from xmlrpc.client import ServerProxy

try:
    from mcp.server.fastmcp import FastMCP, Image
except ImportError:  # mcp >= 2 renamed FastMCP to MCPServer
    from mcp.server.mcpserver import MCPServer as FastMCP  # type: ignore
    from mcp.server.mcpserver import Image  # type: ignore

XMLRPC_PORT = int(os.environ.get("CHATMOL_PYMOL_RPC_PORT", "9123"))
WORKSPACE = os.environ.get("CHATMOL_MCP_WORKSPACE") or os.getcwd()

mcp = FastMCP("pymol")
_rpc = ServerProxy(f"http://127.0.0.1:{XMLRPC_PORT}/RPC2", allow_none=True)
_proc: subprocess.Popen | None = None


def _candidates() -> list[str]:
    env = os.environ.get("CHATMOL_PYMOL_BIN")
    found: list[str] = []
    if env:
        found.append(env)
    for name in ("pymol", "PyMOL"):
        p = shutil.which(name)
        if p:
            found.append(p)
    prefix = os.environ.get("CHATMOL_CONDA_PREFIX")
    if prefix:
        found.append(os.path.join(prefix, "bin", "pymol"))
        found.append(os.path.join(prefix, "Scripts", "pymol.exe"))
        found.append(os.path.join(prefix, "Library", "bin", "pymol.exe"))
    if sys.platform == "darwin":
        found += glob.glob("/Applications/PyMOL*.app/Contents/MacOS/PyMOL")
        found += glob.glob(os.path.expanduser("~/Applications/PyMOL*.app/Contents/MacOS/PyMOL"))
    elif sys.platform.startswith("win"):
        for root in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")):
            if root:
                found += glob.glob(os.path.join(root, "Schrodinger", "PyMOL*", "PyMOLWin.exe"))
                found += glob.glob(os.path.join(root, "PyMOL*", "PyMOLWin.exe"))
    return [p for p in found if p and os.path.exists(p)]


def _alive() -> bool:
    try:
        _rpc.ping()
        return True
    except Exception:
        return False


def _ensure_running(timeout: float = 45.0) -> str:
    global _proc
    if _alive():
        return "PyMOL is already running with XML-RPC enabled."
    cands = _candidates()
    if not cands:
        raise RuntimeError(
            "PyMOL executable not found. Install PyMOL (e.g. `conda install -c conda-forge pymol-open-source`) "
            "or set CHATMOL_PYMOL_BIN."
        )
    exe = cands[0]
    _proc = subprocess.Popen(
        [exe, "-R"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=WORKSPACE,
        start_new_session=True,
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _alive():
            return f"PyMOL started from {exe} with XML-RPC on port {XMLRPC_PORT}."
        if _proc.poll() is not None:
            break
        time.sleep(0.5)
    raise RuntimeError(f"PyMOL did not expose XML-RPC on port {XMLRPC_PORT} within {timeout:.0f}s (exe: {exe}).")


@mcp.tool()
def open_pymol() -> str:
    """Start PyMOL (if not running) with remote control enabled. Call once before other PyMOL tools."""
    return _ensure_running()


@mcp.tool()
def pymol_status() -> str:
    """Report whether PyMOL is reachable and which executable would be used."""
    cands = _candidates()
    state = "running" if _alive() else "not running"
    return f"PyMOL {state}; RPC port {XMLRPC_PORT}; candidates: {cands or 'none found'}"


@mcp.tool()
def run_pymol_command(command: str) -> str:
    """Run one or more PyMOL commands (separated by ';' or newlines), e.g. 'fetch 1ubq; show cartoon; color marine'."""
    _ensure_running()
    lines = [c.strip() for c in command.replace("\n", ";").split(";") if c.strip()]
    for line in lines:
        _rpc.do(line)
    return f"Executed {len(lines)} PyMOL command(s)."


@mcp.tool()
def load_structure_file(path: str, object_name: str = "") -> str:
    """Load a structure file (PDB/mmCIF/SDF/MOL2) from the workspace into PyMOL. Relative paths resolve against the session workspace."""
    _ensure_running()
    full = path if os.path.isabs(path) else os.path.join(WORKSPACE, path)
    if not os.path.exists(full):
        raise RuntimeError(f"File not found: {full}")
    name = object_name or os.path.splitext(os.path.basename(full))[0]
    _rpc.do(f'load "{full}", {name}')
    return f"Loaded {full} as object '{name}'."


@mcp.tool()
def get_pymol_state() -> str:
    """List the objects currently loaded in PyMOL."""
    _ensure_running()
    try:
        names = _rpc.getNames()
    except Exception as exc:  # older PyMOL builds may not expose getNames
        return f"Could not list objects over XML-RPC: {exc}"
    return f"Objects: {list(names) if names else []}"


@mcp.tool()
def save_image(file_name: str = "pymol_view.png", width: int = 1200, height: int = 900, ray: bool = True) -> list:
    """Render the current view to a PNG inside the workspace and return the image. Use a descriptive file_name."""
    _ensure_running()
    if not file_name.lower().endswith(".png"):
        file_name += ".png"
    out = os.path.join(WORKSPACE, os.path.basename(file_name))
    ray_flag = 1 if ray else 0
    _rpc.do(f'png "{out}", width={int(width)}, height={int(height)}, dpi=150, ray={ray_flag}')
    deadline = time.time() + 120
    while time.time() < deadline and not (os.path.exists(out) and os.path.getsize(out) > 0):
        time.sleep(0.3)
    if not os.path.exists(out):
        raise RuntimeError(f"PyMOL did not write {out}")
    with open(out, "rb") as fh:
        data = fh.read()
    return [f"Image saved to {out}", Image(data=data, format="png")]


@mcp.tool()
def save_session(file_name: str = "session.pse") -> str:
    """Save the current PyMOL session (.pse) into the workspace."""
    _ensure_running()
    if not file_name.lower().endswith(".pse"):
        file_name += ".pse"
    out = os.path.join(WORKSPACE, os.path.basename(file_name))
    _rpc.do(f'save "{out}"')
    return f"Session saved to {out}"


if __name__ == "__main__":
    mcp.run()
