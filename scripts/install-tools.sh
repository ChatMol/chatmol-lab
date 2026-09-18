#!/usr/bin/env bash
set -euo pipefail

# Install specific computational biology tools
# Usage: ./install-tools.sh [tool1] [tool2] ...
# Available: protenix, esm, gromacs, foldseek, mmseqs2, all

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

TOOLS="${@:-all}"
INSTALL_DIR="${HOME}/.chatmol-lab/tools"
mkdir -p "$INSTALL_DIR"

install_protenix() {
    info "Installing Protenix..."
    pip install protenix 2>/dev/null || {
        info "Installing from source..."
        cd "$INSTALL_DIR"
        if [ ! -d "protenix" ]; then
            git clone https://github.com/bytedance/protenix.git
        fi
        cd protenix
        pip install -e .
    }
    info "Protenix installed"
}

install_esm() {
    info "Installing ESM..."
    pip install fair-esm
    info "ESM installed"
}

install_esmfold() {
    info "Installing ESMFold dependencies..."
    pip install "fair-esm[esmfold]"
    pip install 'dllogger @ git+https://github.com/NVIDIA/dllogger.git'
    pip install 'openfold @ git+https://github.com/aqlaboratory/openfold.git@4b41059694619831a7db195b7e0988fc4ff3a307'
    info "ESMFold installed"
}

install_gromacs() {
    info "Installing GROMACS..."
    if command -v conda &>/dev/null; then
        conda install -y -c conda-forge gromacs
    elif command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y gromacs
    elif command -v brew &>/dev/null; then
        brew install gromacs
    else
        warn "Cannot auto-install GROMACS. Please install manually:"
        echo "  https://manual.gromacs.org/documentation/current/install-guide/index.html"
        return 1
    fi
    info "GROMACS installed"
}

install_foldseek() {
    info "Installing Foldseek..."
    cd "$INSTALL_DIR"
    if [[ "$(uname -s)" == "Linux" ]]; then
        wget -q https://mmseqs.com/foldseek/foldseek-linux-avx2.tar.gz
        tar xzf foldseek-linux-avx2.tar.gz
        rm foldseek-linux-avx2.tar.gz
        export PATH="$INSTALL_DIR/foldseek/bin:$PATH"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        brew install bioconda/bioconda/foldseek 2>/dev/null || {
            wget -q https://mmseqs.com/foldseek/foldseek-osx-universal.tar.gz
            tar xzf foldseek-osx-universal.tar.gz
            rm foldseek-osx-universal.tar.gz
        }
    fi
    info "Foldseek installed"
}

install_mmseqs2() {
    info "Installing MMseqs2..."
    cd "$INSTALL_DIR"
    if [[ "$(uname -s)" == "Linux" ]]; then
        wget -q https://mmseqs.com/latest/mmseqs-linux-avx2.tar.gz
        tar xzf mmseqs-linux-avx2.tar.gz
        rm mmseqs-linux-avx2.tar.gz
        export PATH="$INSTALL_DIR/mmseqs/bin:$PATH"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        brew install mmseqs2 2>/dev/null || {
            wget -q https://mmseqs.com/latest/mmseqs-osx-universal.tar.gz
            tar xzf mmseqs-osx-universal.tar.gz
            rm mmseqs-osx-universal.tar.gz
        }
    fi
    info "MMseqs2 installed"
}

install_catapro() {
    info "Installing CataPro..."
    pip install catapro 2>/dev/null || {
        info "CataPro not available via pip. Installing from source..."
        cd "$INSTALL_DIR"
        if [ ! -d "catapro" ]; then
            git clone https://github.com/enzyme-design/catapro.git 2>/dev/null || warn "CataPro repo not found"
        fi
        if [ -d "catapro" ]; then
            cd catapro && pip install -e . 2>/dev/null || warn "CataPro installation failed"
        fi
    }
    info "CataPro setup complete"
}

install_pxdesign() {
    info "Installing PxDesign..."
    pip install pxdesign 2>/dev/null || {
        info "PxDesign not available via pip. Setting up from source..."
        cd "$INSTALL_DIR"
        if [ ! -d "pxdesign" ]; then
            git clone https://github.com/protein-design/pxdesign.git 2>/dev/null || warn "PxDesign repo not found"
        fi
        if [ -d "pxdesign" ]; then
            cd pxdesign && pip install -e . 2>/dev/null || warn "PxDesign installation failed"
        fi
    }
    info "PxDesign setup complete"
}

# Run installations
for tool in $TOOLS; do
    case "$tool" in
        protenix)   install_protenix ;;
        esm)        install_esm ;;
        esmfold)    install_esmfold ;;
        gromacs)    install_gromacs ;;
        foldseek)   install_foldseek ;;
        mmseqs2)    install_mmseqs2 ;;
        catapro)    install_catapro ;;
        pxdesign)   install_pxdesign ;;
        all)
            install_esm
            install_protenix
            install_catapro
            install_pxdesign
            install_gromacs
            install_foldseek
            install_mmseqs2
            ;;
        *)
            warn "Unknown tool: $tool"
            echo "Available: protenix, esm, esmfold, gromacs, foldseek, mmseqs2, catapro, pxdesign, all"
            ;;
    esac
done

info "Tool installation complete!"
