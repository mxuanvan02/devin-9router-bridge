#!/usr/bin/env bash
set -e

# Create launchd plist for auto-start on macOS

INSTALL_DIR="${1:-$HOME/.devin-9router-bridge}"
NODE_BIN="${2:-$(which node)}"
USER_NAME=$(whoami)

# Configurable ports (override via environment variables)
GLM_PROXY_PORT="${GLM_PROXY_PORT:-20130}"
ROUTER_PORT="${ROUTER_PORT:-20128}"
WINDSURF_PORT="${WINDSURF_PORT:-8083}"

# Create secure log directory (avoid leaking secrets to /tmp)
mkdir -p "$HOME/.devin-9router-bridge/logs" && chmod 700 "$HOME/.devin-9router-bridge/logs"

PLIST="$HOME/Library/LaunchAgents/com.devin-9router-bridge.glm-proxy.plist"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.devin-9router-bridge.glm-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/glm-proxy.js</string>
        <string>${GLM_PROXY_PORT}</string>
        <string>${ROUTER_PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.devin-9router-bridge/logs/glm-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.devin-9router-bridge/logs/glm-proxy.error.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ Auto-start configured (launchd)"
echo "  Plist: $PLIST"
echo ""
echo "To stop:  launchctl unload $PLIST"
echo "To start: launchctl load $PLIST"
