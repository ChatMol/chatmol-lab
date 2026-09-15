# Third-party notices

ChatMol Lab is distributed under the license in [LICENSE](LICENSE). The
installers and the running application also include or download third-party
software, listed here with the license each is distributed under. Full license
texts ship inside the installed application, in the package metadata of each
component (`<runtime>/pkgs/*/info/licenses`, `<runtime>/lib/python*/site-packages/*.dist-info`,
`node_modules/*/LICENSE`).

This file records what is redistributed. It is not legal advice, and it does
not grant any rights beyond those the listed licenses give.

## Bundled with the desktop installer

| Component | Version | License | Source |
|---|---|---|---|
| Miniforge3 (conda distribution) | 26.3.2-3 | BSD-3-Clause | https://github.com/conda-forge/miniforge |
| Packages installed into the bundled environment by conda-forge | varies | each package's own license | https://conda-forge.org |
| ChatMol MCP viewer servers (PyMOL, ChimeraX) | bundled | MIT | https://github.com/ChatMol/molecule-mcp |
| Electron | see `package.json` | MIT | https://github.com/electron/electron |
| Node.js dependencies | see `package-lock.json` | each package's own license | https://www.npmjs.com |

The Miniforge license requires its copyright notice to be retained and notes
that the packages it installs carry their own licenses. Conda-forge packages
are installed into the environment, not modified.

## Installed into the runtime on first use

Installed by the application into the bundled environment when the matching
feature is first used, not redistributed inside the installer:

| Component | Purpose | License |
|---|---|---|
| biotite | structure analysis (`analyze_structure`) | BSD-3-Clause |
| Biopython | sequence properties (`analyze_structure`) | Biopython License Agreement / BSD-3-Clause |
| mcp (Python SDK) | PyMOL / ChimeraX MCP servers | MIT |
| dssp (optional) | full 8-state secondary structure | BSD-2-Clause |

## Loaded at runtime from a CDN

| Component | Version | License | Source |
|---|---|---|---|
| Mol\* viewer | pinned in `MolstarViewer.tsx` | MIT | https://github.com/molstar/molstar |

## Not included

Third-party scientific services the application can call — NVIDIA BioNeMo NIM,
WeMol, ChatMol Bio, the PDB and other databases — are used through their own
APIs with credentials the user supplies. No client credential for those
services is included in this repository or in the installers.
