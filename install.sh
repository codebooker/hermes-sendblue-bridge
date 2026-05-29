#!/usr/bin/env bash
# install.sh — one-shot setup for the Hermes Sendblue SMS/iMessage bridge.
#
# Usage:
#   chmod +x install.sh && ./install.sh
#
# This script:
#   1. Checks prerequisites (Node.js, npm, Hermes Agent)
#   2. Installs npm dependencies
#   3. Creates .env from .env.example if one doesn't exist
#   4. Sets up systemd user services (optional)
#   5. Prints next steps
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║   Hermes Sendblue Bridge — Installer                        ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Step 1: Prerequisites ─────────────────────────────────────────────────

echo "── Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
    echo -e "${RED}✗ Node.js not found.${NC}"
    echo "  Install: https://nodejs.org/  or  sudo apt install nodejs npm"
    exit 1
fi
NODE_VER=$(node --version)
echo -e "  ${GREEN}✓${NC} Node.js ${NODE_VER}"

# npm
if ! command -v npm &>/dev/null; then
    echo -e "${RED}✗ npm not found.${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm --version)"

# Hermes Agent
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_PYTHON="${HERMES_PYTHON:-$HERMES_HOME/hermes-agent/venv/bin/python}"
if [ ! -f "$HERMES_PYTHON" ]; then
    echo -e "  ${YELLOW}⚠ Hermes venv not found at $HERMES_PYTHON${NC}"
    echo "    The API bridge needs the Hermes CLI. Set HERMES_PYTHON in .env if needed."
else
    echo -e "  ${GREEN}✓${NC} Hermes Agent at $HERMES_PYTHON"
fi

# aiohttp (Python dep for API bridge)
if ! "$HERMES_PYTHON" -c "import aiohttp" 2>/dev/null; then
    echo -e "  ${YELLOW}⚠ aiohttp not installed for Hermes Python. Installing...${NC}"
    "$HERMES_PYTHON" -m pip install aiohttp
fi
echo -e "  ${GREEN}✓${NC} Python aiohttp available"

# ── Step 2: npm dependencies ──────────────────────────────────────────────

echo ""
echo "── Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install
echo -e "  ${GREEN}✓${NC} npm packages installed"

# ── Step 3: .env file ────────────────────────────────────────────────────

echo ""
if [ -f "$SCRIPT_DIR/.env" ]; then
    echo -e "  ${GREEN}✓${NC} .env already exists (skipping)"
else
    echo -e "  ${YELLOW}→ Creating .env from .env.example...${NC}"
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    echo -e "  ${YELLOW}⚠  EDIT .env with your Sendblue & Hermes API keys before running!${NC}"
    echo "     $SCRIPT_DIR/.env"
fi

# ── Step 4: systemd (optional) ────────────────────────────────────────────

echo ""
echo "── systemd user services"
read -p "  Install systemd user services? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$SYSTEMD_DIR"

    # Copy services with paths adjusted
    for svc in hermes-api-bridge.service sendblue-bridge.service; do
        sed "s|%h/hermes-sendblue-bridge|$SCRIPT_DIR|g" \
            "$SCRIPT_DIR/systemd/$svc" > "$SYSTEMD_DIR/$svc"
        echo -e "  ${GREEN}✓${NC} Installed $SYSTEMD_DIR/$svc"
    done

    systemctl --user daemon-reload

    echo ""
    echo -e "  ${YELLOW}→ To enable services at boot:${NC}"
    echo "    systemctl --user enable hermes-api-bridge.service sendblue-bridge.service"
    echo ""
    echo -e "  ${YELLOW}→ To start now:${NC}"
    echo "    systemctl --user start hermes-api-bridge.service sendblue-bridge.service"
else
    echo "  Skipped. You can run manually:"
    echo "    ./start-sendblue.sh"
fi

# ── Done ─────────────────────────────────────────────────────────────────

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║   ✓ Installation complete!                                  ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Next steps:"
echo "  1. Edit .env with your Sendblue credentials:"
echo "     $SCRIPT_DIR/.env"
echo ""
echo "  2. Customize personalities in sendblue-bridge-polling.js"
echo "     (search for 'personalityConfig')"
echo ""
echo "  3. Start the bridge:"
echo "     ./start-sendblue.sh"
echo ""
echo "  Your Sendblue number will now respond via Hermes!"
echo ""
