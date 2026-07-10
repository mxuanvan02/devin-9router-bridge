#!/usr/bin/env bash
set -e

# Create systemd user service for auto-start on Linux

INSTALL_DIR="${1:-$HOME/.devin-9router-bridge}"
NODE_BIN="${2:-$(which node)}"
USER_NAME=$(whoami)

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/devin-9router-bridge-glm-proxy.service"

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Devin 9Router Bridge — glm-proxy
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $INSTALL_DIR/glm-proxy.js 20130 20128
Restart=on-failure
RestartSec=5
StandardOutput=append:/tmp/glm-proxy.log
StandardError=append:/tmp/glm-proxy.error.log

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
