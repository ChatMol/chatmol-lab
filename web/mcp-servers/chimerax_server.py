"""
ChatMol Lab bundled MCP server for UCSF ChimeraX.

Derived from ChatMol/molecule-mcp (MIT). Differences from the upstream script:
- cross-platform ChimeraX discovery (macOS app bundle, Windows Program Files,
  Linux PATH), overridable with CHATMOL_CHIMERAX_BIN;
- waits for the XML-RPC server to come up instead of returning immediately;
- images are returned inline as MCP image content and written to the
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

XMLRPC_PORT = int(os.environ.get("CHATMOL_CHIMERAX_RPC_PORT", "42184"))
WORKSPACE = os.environ.get("CHATMOL_MCP_WORKSPACE") or os.getcwd()

mcp = FastMCP("chimerax")
_rpc = ServerProxy(f"http://127.0.0.1:{XMLRPC_PORT}/RPC2", allow_none=True)
_proc: subprocess.Popen | None = None


def _candidates() -> list[str]:
    env = os.environ.get("CHATMOL_CHIMERAX_BIN")
    found: list[str] = []
    if env:
        found.append(env)
    for name in ("chimerax", "ChimeraX"):
        p = shutil.which(name)
        if p:
            found.append(p)
    if sys.platform == "darwin":
        found += sorted(glob.glob("/Applications/ChimeraX*.app/Contents/bin/ChimeraX"), reverse=True)
        found += sorted(glob.glob(os.path.expanduser("~/Applications/ChimeraX*.app/Contents/bin/ChimeraX")), reverse=True)
    elif sys.platform.startswith("win"):
        for root in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")):
            if root:
                found += sorted(glob.glob(os.path.join(root, "ChimeraX*", "bin", "ChimeraX.exe")), reverse=True)
    else:
        found += sorted(glob.glob("/opt/UCSF/ChimeraX*/bin/ChimeraX"), reverse=True)
        found += glob.glob("/usr/bin/chimerax") + glob.glob("/usr/local/bin/chimerax")
    return [p for p in found if p and os.path.exists(p)]


def _alive() -> bool:
    try:
        _rpc.run_command("version")
        return True
    except Exception:
        return False


def _ensure_running(timeout: float = 90.0) -> str:
    global _proc
    if _alive():
        return "ChimeraX is already running with remote control enabled."
    cands = _candidates()
    if not cands:
        raise RuntimeError(
            "ChimeraX executable not found. Install UCSF ChimeraX from https://www.cgl.ucsf.edu/chimerax/download.html "
            "or set CHATMOL_CHIMERAX_BIN."
        )
    exe = cands[0]
    _proc = subprocess.Popen(
        [exe, "--cmd", f"remotecontrol xmlrpc true port {XMLRPC_PORT}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=WORKSPACE,
        start_new_session=True,
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _alive():
            return f"ChimeraX started from {exe} with XML-RPC on port {XMLRPC_PORT}."
        if _proc.poll() is not None:
            break
        time.sleep(0.5)
    raise RuntimeError(f"ChimeraX did not expose XML-RPC on port {XMLRPC_PORT} within {timeout:.0f}s (exe: {exe}).")


@mcp.tool()
def open_chimerax() -> str:
    """Start ChimeraX (if not running) with remote control enabled. Call once before other ChimeraX tools."""
    return _ensure_running()


@mcp.tool()
def chimerax_status() -> str:
    """Report whether ChimeraX is reachable and which executable would be used."""
    cands = _candidates()
    state = "running" if _alive() else "not running"
    return f"ChimeraX {state}; RPC port {XMLRPC_PORT}; candidates: {cands or 'none found'}"


@mcp.tool()
def run_chimerax_command(command: str) -> str:
    """Run one or more ChimeraX commands (separated by ';' or newlines), e.g. 'open 1ubq; cartoon; color bychain'. Returns the command log."""
    _ensure_running()
    lines = [c.strip() for c in command.replace("\n", ";").split(";") if c.strip()]
    outputs = []
    for line in lines:
        result = _rpc.run_command(line)
        outputs.append(str(result) if result is not None else "")
    text = "\n".join(o for o in outputs if o)
    return text or f"Executed {len(lines)} ChimeraX command(s)."


@mcp.tool()
def load_structure_file(path: str) -> str:
    """Open a structure file (PDB/mmCIF/SDF/MOL2/map) from the workspace in ChimeraX. Relative paths resolve against the session workspace."""
    _ensure_running()
    full = path if os.path.isabs(path) else os.path.join(WORKSPACE, path)
    if not os.path.exists(full):
        raise RuntimeError(f"File not found: {full}")
    _rpc.run_command(f'open "{full}"')
    return f"Opened {full} in ChimeraX."


@mcp.tool()
def save_image(file_name: str = "chimerax_view.png", width: int = 1200, height: int = 900, supersample: int = 3) -> list:
    """Save the current ChimeraX view as a PNG in the workspace and return the image. Use a descriptive file_name."""
    _ensure_running()
    if not file_name.lower().endswith(".png"):
        file_name += ".png"
    out = os.path.join(WORKSPACE, os.path.basename(file_name))
    _rpc.run_command(f'save "{out}" width {int(width)} height {int(height)} supersample {int(supersample)}')
    deadline = time.time() + 120
    while time.time() < deadline and not (os.path.exists(out) and os.path.getsize(out) > 0):
        time.sleep(0.3)
    if not os.path.exists(out):
        raise RuntimeError(f"ChimeraX did not write {out}")
    with open(out, "rb") as fh:
        data = fh.read()
    return [f"Image saved to {out}", Image(data=data, format="png")]


@mcp.tool()
def save_session(file_name: str = "session.cxs") -> str:
    """Save the current ChimeraX session (.cxs) into the workspace."""
    _ensure_running()
    if not file_name.lower().endswith(".cxs"):
        file_name += ".cxs"
    out = os.path.join(WORKSPACE, os.path.basename(file_name))
    _rpc.run_command(f'save "{out}"')
    return f"Session saved to {out}"


if __name__ == "__main__":
    mcp.run()
