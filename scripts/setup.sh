#!/usr/bin/env bash
set -euo pipefail

echo "============================================"
echo "  ChatMol Lab - Setup"
echo "============================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Detect OS
OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected: $OS $ARCH"

# ============================================
# 1. System Dependencies
# ============================================
info "Checking system dependencies..."

check_cmd() {
    if command -v "$1" &>/dev/null; then
        info "  ✓ $1 found"
        return 0
    else
        warn "  ✗ $1 not found"
        return 1
    fi
}

# Node.js
if ! check_cmd node; then
    info "Installing Node.js..."
    if [[ "$OS" == "Darwin" ]]; then
        brew install node
    elif [[ "$OS" == "Linux" ]]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
fi

# Python
if ! check_cmd python3; then
    error "Python 3 is required. Please install Python 3.10+"
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
info "  Python version: $PYTHON_VERSION"

# pip/uv
if check_cmd uv; then
    PIP="uv pip"
elif check_cmd pip3; then
    PIP="pip3"
else
    info "Installing pip..."
    python3 -m ensurepip --upgrade
    PIP="pip3"
fi

# ============================================
# 2. Python Environment
# ============================================
info "Setting up Python environment..."

VENV_DIR="${HOME}/.chatmol/venv"
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
    info "  Created virtual environment at $VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
info "  Activated virtual environment"

# Core Python dependencies
info "Installing core Python packages..."
pip install --quiet --upgrade pip
pip install --quiet \
    numpy \
    pandas \
    scipy \
    scikit-learn \
    matplotlib \
    seaborn \
    plotly \
    jupyter \
    jupyterlab \
    biopython \
    requests \
    tqdm

# ============================================
# 3. Bioinformatics Tools
# ============================================
info "Installing bioinformatics Python packages..."

pip install --quiet \
    fair-esm \
    biotite \
    pymsaviz \
    primer3-py \
    pysam \
    scanpy \
    anndata \
    leidenalg 2>/dev/null || warn "Some optional packages failed to install"

# ============================================
# 4. Protein Design Tools
# ============================================
info "Installing protein design tools..."

# Protenix
pip install --quiet protenix 2>/dev/null || warn "Protenix not available via pip - use Modal for GPU execution"

# ESM
pip install --quiet fair-esm 2>/dev/null || true

# ============================================
# 5. Modal Setup (for GPU computation)
# ============================================
info "Setting up Modal for GPU computation..."

pip install --quiet modal
if command -v modal &>/dev/null; then
    info "  Modal installed. Run 'modal setup' to authenticate."
else
    warn "  Modal CLI not found in PATH"
fi

# Clone biomodals
BIOMODALS_DIR="${HOME}/.chatmol/biomodals"
if [ ! -d "$BIOMODALS_DIR" ]; then
    info "  Cloning biomodals..."
    git clone --depth 1 https://github.com/hgbrian/biomodals.git "$BIOMODALS_DIR" 2>/dev/null || warn "Failed to clone biomodals"
fi

# ============================================
# 6. GROMACS
# ============================================
if ! check_cmd gmx; then
    info "GROMACS not found. Install options:"
    echo "  - Conda: conda install -c conda-forge gromacs"
    echo "  - Ubuntu: sudo apt-get install gromacs"
    echo "  - macOS: brew install gromacs"
    echo "  - From source: https://manual.gromacs.org/documentation/current/install-guide/index.html"
fi

# ============================================
# 7. Web Frontend
# ============================================
info "Installing web frontend dependencies..."

cd "$(dirname "$0")/../web"
if [ -f "package.json" ]; then
    npm install --silent 2>/dev/null || npm install
    info "  Frontend dependencies installed"
fi
cd -

# ============================================
# 8. OpenCode (optional)
# ============================================
info "Checking for OpenCode..."
if check_cmd opencode; then
    info "  OpenCode is installed"
else
    info "  OpenCode not found. Install with: npm install -g opencode"
    echo "  Or use Bun: bun install -g opencode"
fi

# ============================================
# 9. Workspace Setup
# ============================================
WORKSPACE="${HOME}/.chatmol/workspace"
mkdir -p "$WORKSPACE"
info "Workspace directory: $WORKSPACE"

# ============================================
# 10. Environment Configuration
# ============================================
ENV_FILE="$(dirname "$0")/../.env"
if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" << 'ENVEOF'
# ChatMol Lab Configuration
# Copy this to .env.local and fill in your API keys

# LLM API Key (required for built-in agent)
ANTHROPIC_API_KEY=

# Model selection
MODEL=claude-sonnet-4-20250514

# OpenCode server URL (if using OpenCode as backend)
# OPENCODE_URL=http://localhost:3001

# Workspace directory for file operations
WORKSPACE_DIR=${HOME}/.chatmol/workspace

# Modal token (for GPU computation)
# MODAL_TOKEN_ID=
# MODAL_TOKEN_SECRET=
ENVEOF
    info "Created .env template - edit with your API keys"
fi

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Set your API key: export ANTHROPIC_API_KEY=your-key"
echo "  2. Start the frontend: cd web && npm run dev"
echo "  3. Open http://localhost:3000"
echo ""
echo "For GPU computation (protein structure prediction, etc.):"
echo "  1. Run 'modal setup' to authenticate"
echo "  2. Tools will automatically use Modal for GPU tasks"
echo ""
echo "Optional: Install OpenCode for enhanced agent capabilities:"
echo "  npm install -g opencode"
echo "  opencode serve  # Start in server mode"
echo ""
