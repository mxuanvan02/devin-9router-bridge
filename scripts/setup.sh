#!/usr/bin/env bash
set -e

# Devin-9Router-Bridge Setup
# Connects Devin models (GLM-5.2, etc.) to Claude Code + ClaudeKit via 9router

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_DIR="$SCRIPT_DIR/../proxy"
INSTALL_DIR="$HOME/.devin-9router-bridge"
NODE_BIN="${NODE_BIN:-$(which node)}"

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
echo "  ║   Devin models → 9router → Claude Code + ClaudeKit   ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""

# ─── 1. Prerequisites ────────────────────────────────────────────────────────
echo -e "${CYAN}[1/6]${NC} Checking prerequisites..."
echo ""

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install: brew install node"
ok "Node.js: $(node --version)"

command -v 9router >/dev/null 2>&1 || fail "9router not found. Install: npm install -g 9router"
ok "9router: $(9router --version 2>/dev/null || echo 'installed')"

command -v claude >/dev/null 2>&1 || fail "Claude Code not found. Install: npm install -g @anthropic-ai/claude-code"
ok "Claude Code: $(claude --version 2>/dev/null || echo 'installed')"

# Check Devin credentials
CRED_FILE="$HOME/.codeium/windsurf/credentials.toml"
if [ ! -f "$CRED_FILE" ]; then
    warn "Devin credentials not found at: $CRED_FILE"
    echo "       Install Windsurf IDE and login, or create the file manually."
    echo "       See: docs/GETTING_DEVIN_TOKEN.md"
    exit 1
fi
if ! grep -q "windsurf_api_key" "$CRED_FILE" 2>/dev/null; then
    fail "No windsurf_api_key in credentials.toml"
fi
ok "Devin credentials found"

echo ""

# ─── 2. Install proxy files ──────────────────────────────────────────────────
echo -e "${CYAN}[2/6]${NC} Installing proxy files..."
echo ""

mkdir -p "$INSTALL_DIR"
cp "$PROXY_DIR/glm-proxy.js" "$INSTALL_DIR/"
cp "$PROXY_DIR/windsurf-server.js" "$INSTALL_DIR/"
cp "$PROXY_DIR/windsurf-provider.js" "$INSTALL_DIR/"
ok "Installed to: $INSTALL_DIR/"

echo ""

# ─── 3. Start windsurf-server (Devin → OpenAI API) ───────────────────────────
echo -e "${CYAN}[3/6]${NC} Starting windsurf-server (port 8083)..."
echo ""

if curl -s http://127.0.0.1:8083/health >/dev/null 2>&1; then
    ok "Already running"
else
    nohup "$NODE_BIN" "$INSTALL_DIR/windsurf-server.js" 8083 >/tmp/windsurf-server.log 2>&1 &
    sleep 2
    curl -s http://127.0.0.1:8083/health >/dev/null 2>&1 && ok "Started" || fail "Failed. Check /tmp/windsurf-server.log"
fi

echo ""

# ─── 4. Configure 9router ───────────────────────────────────────────────────
echo -e "${CYAN}[4/6]${NC} Configuring 9router..."
echo ""

# Check if 9router is running
if ! curl -s http://127.0.0.1:20128/health >/dev/null 2>&1; then
    warn "9router not running on port 20128. Start it with: 9router start"
    echo "       After starting, re-run this script."
    exit 1
fi
ok "9router is running"

# Check if windsurf provider is already configured
ROUTER_DB="$HOME/.9router/db.json"
if grep -q "8083" "$ROUTER_DB" 2>/dev/null; then
    ok "Windsurf provider already configured in 9router"
else
    info "Add windsurf provider to 9router:"
    echo "       In 9router UI → Settings → Providers → Add Custom Provider"
    echo "       Type: OpenAI-compatible"
    echo "       Base URL: http://127.0.0.1:8083/v1"
    echo "       API Key: devin"
    warn "Configure this manually, then press Enter to continue..."
    read
fi

echo ""

# ─── 5. Start glm-proxy ──────────────────────────────────────────────────────
echo -e "${CYAN}[5/6]${NC} Starting glm-proxy (port 20130)..."
echo ""

if curl -s http://127.0.0.1:20130/health >/dev/null 2>&1; then
    ok "Already running"
else
    nohup "$NODE_BIN" "$INSTALL_DIR/glm-proxy.js" 20130 20128 >/tmp/glm-proxy.log 2>&1 &
    sleep 2
    curl -s http://127.0.0.1:20130/health >/dev/null 2>&1 && ok "Started" || fail "Failed. Check /tmp/glm-proxy.log"
fi

echo ""

# ─── 6. Configure Claude Code ────────────────────────────────────────────────
echo -e "${CYAN}[6/6]${NC} Configuring Claude Code..."
echo ""

SETTINGS_FILE="$HOME/.claude/settings.json"
API_KEY=$(python3 -c "
import json
d = json.load(open('$SETTINGS_FILE'))
print(d.get('env',{}).get('ANTHROPIC_API_KEY',''))
" 2>/dev/null)

if [ -z "$API_KEY" ]; then
    warn "No ANTHROPIC_API_KEY found in settings.json"
    echo "       Set your 9router API key manually."
    API_KEY="your-9router-api-key"
fi

# Backup existing settings
if [ -f "$SETTINGS_FILE" ]; then
    cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak.$(date +%Y%m%d%H%M%S)"
    ok "Backed up existing settings.json"
fi

# Update settings.json
python3 -c "
import json
with open('$SETTINGS_FILE') as f:
    d = json.load(f)
d.setdefault('env', {})
d['env']['ANTHROPIC_BASE_URL'] = 'http://localhost:20130'
d['env']['ANTHROPIC_API_KEY'] = '$API_KEY'
d['env']['ANTHROPIC_DEFAULT_OPUS_MODEL'] = 'ws/glm-5-2'
d['env']['ANTHROPIC_DEFAULT_SONNET_MODEL'] = 'ws/glm-5-2'
d['env']['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = 'ws/glm-5-2'
d['model'] = 'ws/glm-5-2'
d.setdefault('fallbackModels', [])
if 'cx/gpt-5.5' not in d['fallbackModels']:
    d['fallbackModels'].insert(0, 'cx/gpt-5.5')
with open('$SETTINGS_FILE', 'w') as f:
    json.dump(d, f, indent=2)
"
ok "Updated ~/.claude/settings.json"
echo ""

# ─── Done ────────────────────────────────────────────────────────────────────
echo -e "${GREEN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║   ✓ Setup Complete!                                  ║${NC}"
echo -e "${GREEN}  ╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ║   Architecture:                                       ║${NC}"
echo -e "${GREEN}  ║   Claude Code → glm-proxy (20130)                     ║${NC}"
echo -e "${GREEN}  ║              → 9router (20128)                        ║${NC}"
echo -e "${GREEN}  ║              → windsurf-server (8083)                 ║${NC}"
echo -e "${GREEN}  ║              → Devin/Cognition (GLM-5.2)              ║${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ║   Next steps:                                         ║${NC}"
echo -e "${GREEN}  ║   1. Restart Claude Code (exit and relaunch)          ║${NC}"
echo -e "${GREEN}  ║   2. Install ClaudeKit: ./scripts/install-claudekit.sh║${NC}"
echo -e "${GREEN}  ║   3. Try: /ck-help in Claude Code                     ║${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""
