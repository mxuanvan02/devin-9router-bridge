#!/usr/bin/env bash
set -e

# Create systemd user service for auto-start on Linux

INSTALL_DIR="${1:-$HOME/.devin-9router-bridge}"
NODE_BIN="${2:-$(which node)}"
USER_NAME=$(whoami)

# Configurable ports (override via environment variables)
GLM_PROXY_PORT="${GLM_PROXY_PORT:-20130}"
ROUTER_PORT="${ROUTER_PORT:-20128}"
WINDSURF_PORT="${WINDSURF_PORT:-8083}"

# Create secure log directory (avoid leaking secrets to /tmp)
mkdir -p "$HOME/.devin-9router-bridge/logs" && chmod 700 "$HOME/.devin-9router-bridge/logs"

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/devin-9router-bridge-glm-proxy.service"

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Devin 9Router Bridge — glm-proxy
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $INSTALL_DIR/glm-proxy.js ${GLM_PROXY_PORT} ${ROUTER_PORT}
Restart=on-failure
RestartSec=5
StandardOutput=append:$HOME/.devin-9router-bridge/logs/glm-proxy.log
StandardError=append:$HOME/.devin-9router-bridge/logs/glm-proxy.error.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable devin-9router-bridge-glm-proxy.service
systemctl --user restart devin-9router-bridge-glm-proxy.service

# Ensure user services survive logout
if ! loginctl show-user "$USER_NAME" 2>/dev/null | grep -q "Linger=yes"; then
    loginctl enable-linger "$USER_NAME" 2>/dev/null || true
    echo "  (enabled linger so service survives logout)"
fi

echo "✓ Auto-start configured (systemd user service)"
echo "  Service: $SERVICE_FILE"
echo ""
echo "To stop:  systemctl --user stop devin-9router-bridge-glm-proxy"
echo "To start: systemctl --user start devin-9router-bridge-glm-proxy"
echo "To check: systemctl --user status devin-9router-bridge-glm-proxy"
