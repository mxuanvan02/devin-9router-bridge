#!/usr/bin/env bash
set -e

# Devin → 9Router Bridge Setup
# Connects Devin models (GLM-5.2, etc.) to Claude Code via 9router
#
# Prerequisites (must be installed BEFORE running this script):
#   - Node.js 18+
#   - 9router (npm install -g 9router)
#   - Claude Code (npm install -g @anthropic-ai/claude-code)
#   - Devin CLI authenticated (devin auth status should show "Logged in")

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_DIR="$SCRIPT_DIR/../proxy"
INSTALL_DIR="$HOME/.devin-9router-bridge"
NODE_BIN="${NODE_BIN:-$(which node)}"

# Configurable ports (override via environment variables)
GLM_PROXY_PORT="${GLM_PROXY_PORT:-20130}"
ROUTER_PORT="${ROUTER_PORT:-20128}"
WINDSURF_PORT="${WINDSURF_PORT:-8083}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
info() { echo -e "  ${CYAN}ℹ${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }

echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║   Devin-9Router-Bridge — Setup                       ║"
echo "  ║   Devin models → 9router → Claude Code               ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""

# ─── 1. Prerequisites ────────────────────────────────────────────────────────
echo -e "${CYAN}[1/7]${NC} Checking prerequisites..."
echo ""

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install: brew install node"
ok "Node.js: $(node --version)"

command -v 9router >/dev/null 2>&1 || fail "9router not found. Install: npm install -g 9router"
ok "9router: $(9router --version 2>/dev/null || echo 'installed')"

command -v claude >/dev/null 2>&1 || fail "Claude Code not found. Install: npm install -g @anthropic-ai/claude-code"
ok "Claude Code: $(claude --version 2>/dev/null || echo 'installed')"

# ClaudeKit is optional (not required for the bridge to function)
if command -v ck >/dev/null 2>&1; then
    ok "ClaudeKit: $(ck --version 2>/dev/null || echo 'installed')"
else
    info "ClaudeKit not found (optional)"
fi

# Check Devin credentials — try both Windsurf IDE path and Devin CLI path
CRED_FILE=""
if [ -f "$HOME/.local/share/devin/credentials.toml" ]; then
    CRED_FILE="$HOME/.local/share/devin/credentials.toml"
    ok "Devin credentials found (Devin CLI path)"
elif [ -f "$HOME/.codeium/windsurf/credentials.toml" ]; then
    CRED_FILE="$HOME/.codeium/windsurf/credentials.toml"
    ok "Devin credentials found (Windsurf IDE path)"
else
    warn "Devin credentials not found."
    echo "       Run 'devin auth login' to authenticate with Devin."
    echo "       Or install Windsurf IDE and login."
    echo "       See: docs/GETTING_DEVIN_TOKEN.md"
    exit 1
fi

if ! grep -q "windsurf_api_key" "$CRED_FILE" 2>/dev/null; then
    fail "No windsurf_api_key in $CRED_FILE"
fi

echo ""

# ─── 2. Install proxy files ──────────────────────────────────────────────────
echo -e "${CYAN}[2/7]${NC} Installing proxy files..."
echo ""

mkdir -p "$INSTALL_DIR"
cp "$PROXY_DIR/glm-proxy.js" "$INSTALL_DIR/"
cp "$PROXY_DIR/windsurf-server.js" "$INSTALL_DIR/"
cp "$PROXY_DIR/windsurf-provider.js" "$INSTALL_DIR/"

# Copy proto schema
PROTO_SRC="$SCRIPT_DIR/../proto/windsurf.proto"
if [ -f "$PROTO_SRC" ]; then
    mkdir -p "$INSTALL_DIR/proto"
    cp "$PROTO_SRC" "$INSTALL_DIR/proto/"
    ok "Proto schema installed"
fi

# Install npm dependencies (protobufjs)
if [ -f "$SCRIPT_DIR/../package.json" ]; then
    cd "$SCRIPT_DIR/.."
    if [ ! -d "node_modules" ] || [ ! -d "node_modules/protobufjs" ]; then
        info "Installing npm dependencies (protobufjs)..."
        npm install --production 2>&1 | tail -3
    fi
    ok "Dependencies ready"
    # Link node_modules to install dir so windsurf-provider can find protobufjs
    if [ -d "node_modules" ]; then
        ln -sf "$(pwd)/node_modules" "$INSTALL_DIR/node_modules"
    fi
    cd "$SCRIPT_DIR"
fi

ok "Installed to: $INSTALL_DIR/"

echo ""

# ─── 3. Start windsurf-server (Devin → OpenAI API) ───────────────────────────
echo -e "${CYAN}[3/7]${NC} Starting windsurf-server (port $WINDSURF_PORT)..."
echo ""

if curl -s http://127.0.0.1:$WINDSURF_PORT/health >/dev/null 2>&1; then
    ok "Already running"
else
    nohup "$NODE_BIN" "$INSTALL_DIR/windsurf-server.js" $WINDSURF_PORT >/tmp/windsurf-server.log 2>&1 &
    sleep 2
    curl -s http://127.0.0.1:$WINDSURF_PORT/health >/dev/null 2>&1 && ok "Started" || fail "Failed. Check /tmp/windsurf-server.log"
fi

echo ""

# ─── 4. Configure 9router ───────────────────────────────────────────────────
echo -e "${CYAN}[4/7]${NC} Configuring 9router..."
echo ""

# Check if 9router is running
if ! curl -s http://127.0.0.1:$ROUTER_PORT/ >/dev/null 2>&1; then
    warn "9router not running on port $ROUTER_PORT."
    echo "       Start it with: 9router start"
    echo "       If your 9router uses a different port, set ROUTER_PORT env var."
    echo "       After starting, re-run this script."
    exit 1
fi
ok "9router is running (port $ROUTER_PORT)"

# Check if windsurf provider is already configured
ROUTER_DB="$HOME/.9router/db.json"
if [ -f "$ROUTER_DB" ] && grep -q "$WINDSURF_PORT" "$ROUTER_DB" 2>/dev/null; then
    ok "Windsurf provider already configured in 9router"
else
    info "Add windsurf provider to 9router:"
    echo "       In 9router UI → Settings → Providers → Add Custom Provider"
    echo "       Type: OpenAI-compatible"
    echo "       Base URL: http://127.0.0.1:$WINDSURF_PORT/v1"
    echo "       API Key: devin"
    warn "Configure this in 9router UI, then press Enter to continue..."
    read -r
fi

echo ""

# ─── 5. Start glm-proxy ──────────────────────────────────────────────────────
echo -e "${CYAN}[5/7]${NC} Starting glm-proxy (port $GLM_PROXY_PORT → $ROUTER_PORT)..."
echo ""

if curl -s http://127.0.0.1:$GLM_PROXY_PORT/health >/dev/null 2>&1; then
    ok "Already running"
else
    nohup "$NODE_BIN" "$INSTALL_DIR/glm-proxy.js" $GLM_PROXY_PORT $ROUTER_PORT >/tmp/glm-proxy.log 2>&1 &
    sleep 2
    curl -s http://127.0.0.1:$GLM_PROXY_PORT/health >/dev/null 2>&1 && ok "Started" || fail "Failed. Check /tmp/glm-proxy.log"
fi

echo ""

# ─── 6. Configure Claude Code ────────────────────────────────────────────────
echo -e "${CYAN}[6/7]${NC} Configuring Claude Code..."
echo ""

SETTINGS_FILE="$HOME/.claude/settings.json"

# Try to detect existing 9router API key
API_KEY=""
if [ -f "$SETTINGS_FILE" ]; then
    API_KEY=$(python3 -c "
import json
try:
    d = json.load(open('$SETTINGS_FILE'))
    print(d.get('env',{}).get('ANTHROPIC_API_KEY',''))
except: print('')
" 2>/dev/null)
fi

if [ -z "$API_KEY" ]; then
    # Try to get 9router API key from 9router config
    if [ -f "$HOME/.9router/auth" ]; then
        API_KEY=$(cat "$HOME/.9router/auth" 2>/dev/null | head -1)
    fi
fi

if [ -z "$API_KEY" ]; then
    warn "No API key found. You'll need to set it manually."
    echo "       Get your 9router API key from the 9router UI."
    API_KEY="YOUR_9ROUTER_API_KEY"
fi

# Backup existing settings
if [ -f "$SETTINGS_FILE" ]; then
    cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak.$(date +%Y%m%d%H%M%S)"
    ok "Backed up existing settings.json"
fi

# Update settings.json — preserve existing keys, only override what we need
python3 -c "
import json, sys

settings_file = '$SETTINGS_FILE'
api_key = '$API_KEY'
base_url = 'http://localhost:$GLM_PROXY_PORT'

try:
    with open(settings_file) as f:
        d = json.load(f)
except:
    d = {}

d.setdefault('env', {})
d['env']['ANTHROPIC_BASE_URL'] = base_url
d['env']['ANTHROPIC_API_KEY'] = api_key
d['env']['ANTHROPIC_DEFAULT_OPUS_MODEL'] = 'ws/glm-5-2'
d['env']['ANTHROPIC_DEFAULT_SONNET_MODEL'] = 'ws/glm-5-2'
d['env']['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = 'ws/glm-5-2'
d['model'] = 'ws/glm-5-2'

with open(settings_file, 'w') as f:
    json.dump(d, f, indent=2)
"
ok "Updated ~/.claude/settings.json"
ok "  ANTHROPIC_BASE_URL = http://localhost:$GLM_PROXY_PORT"
ok "  model = ws/glm-5-2"
echo ""

# ─── Done ────────────────────────────────────────────────────────────────────
echo -e "${GREEN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║   ✓ Setup Complete!                                  ║${NC}"
echo -e "${GREEN}  ╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ║   Architecture:                                       ║${NC}"
echo -e "${GREEN}  ║   Claude Code → glm-proxy (port $GLM_PROXY_PORT)               ${NC}"
echo -e "${GREEN}  ║              → 9router (port $ROUTER_PORT)                    ${NC}"
echo -e "${GREEN}  ║              → windsurf-server (port $WINDSURF_PORT)          ${NC}"
echo -e "${GREEN}  ║              → Devin/Cognition (GLM-5.2)                    ${NC}"
echo -e "${GREEN}  ║                                                      ${NC}"
echo -e "${GREEN}  ║   Next steps:                                         ║${NC}"
echo -e "${GREEN}  ║   1. Restart Claude Code (exit and relaunch)          ║${NC}"
echo -e "${GREEN}  ║   2. Try any prompt in Claude Code                    ║${NC}"
echo -e "${GREEN}  ║   3. (Optional) Auto-start: ./scripts/auto-start.sh   ║${NC}"
echo -e "${GREEN}  ║                                                      ${NC}"
echo -e "${GREEN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""
