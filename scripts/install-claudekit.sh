#!/usr/bin/env bash
set -e

# Install ClaudeKit and configure it for use with Devin-9Router-Bridge

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ╔════════════════════════════════════════════════╗"
echo "  ║   ClaudeKit Installation                       ║"
echo "  ╚════════════════════════════════════════════════╝"
echo ""

# Check if ClaudeKit is already installed
if command -v ck >/dev/null 2>&1; then
    echo "  ClaudeKit is already installed: $(ck --version 2>/dev/null)"
    echo "  Do you want to reinstall? [y/N]"
    read -r response
    [[ "$response" =~ ^[Yy]$ ]] || exit 0
fi

echo "  Installing ClaudeKit..."
echo ""

# Clone ClaudeKit
KIT_DIR="$HOME/Claude-KIT"
if [ ! -d "$KIT_DIR/claudekit-engineer" ]; then
    echo "  Cloning ClaudeKit..."
    mkdir -p "$KIT_DIR"
    cd "$KIT_DIR"
    git clone https://github.com/unified-vista/claudekit-engineer.git claudekit-engineer 2>/dev/null || {
        echo "  Could not clone from GitHub. Please install manually."
        exit 1
    }
fi

cd "$KIT_DIR/claudekit-engineer"

# Run ClaudeKit installer
if [ -f "install.sh" ]; then
    echo "  Running ClaudeKit installer..."
    bash install.sh
elif [ -f "ck" ]; then
    npm install -g .
else
    echo "  No installer found. Please install manually."
    exit 1
fi

echo ""
echo "  ✓ ClaudeKit installed!"
echo ""
echo "  Verify with: ck --version"
echo "  Then try: /ck-help in Claude Code"
echo ""
