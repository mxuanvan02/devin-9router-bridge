# Devin → 9Router Bridge

> Use **Devin's GLM-5.2** (and other Cognition models) as a backend for **Claude Code** — no Anthropic API key required.
>
> 💡 **Why GLM-5.2?** Devin Pro (Windsurf) includes **promo free credits** for GLM-5.2 High, making it essentially free to use. This bridge lets you tap into those credits from Claude Code.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue.svg)](#)

---

## Why?

[Devin](https://devin.ai) by Cognition provides access to powerful models like **GLM-5.2 High**, but its API isn't directly compatible with [Claude Code](https://docs.anthropic.com/en/docs/claude-code). GLM-5.2 is included as a **promo free model** with Devin Pro (Windsurf) subscriptions, making it essentially free to use. This bridge solves four incompatibilities:

| Problem | Solution |
|---------|----------|
| GLM-5.2 errors on `"You are Claude Code"` identity | Rewrites system prompt to generic assistant |
| GLM-5.2 has no native `tool_use` support | Converts tools ↔ text instructions (XML tags) |
| Cognition API content filter blocks Claude Code prompts | Sanitizes security/billing/imperative language |
| GLM-5.2 can't see images | Routes images to kimi-k2-7/swe-1-7 (via ACP+PIL) for description, then GLM-5.2 answers using the description |

## Architecture

```
Claude Code (Anthropic API)
      ↓
glm-proxy (port 20130)         ← Rewrites prompts, converts tools, vision routing
      ↓
      ├─ Text-only requests ──→ 9router (port 20128) → windsurf-server → GLM-5.2
      │
      └─ Image requests ──────→ windsurf-server (port 8083) for image description
                                  (kimi-k2-7 = "eyes" via ACP+PIL)
                                  ↓
                                  Replace image with text description
                                  ↓
                                  9router → GLM-5.2 = "brain" (answers using description)
```

### Vision: "Eyes + Brain" pattern

GLM-5.2 doesn't support vision. When Claude Code sends an image:

1. **kimi-k2-7** (the "eyes") analyzes the image via ACP path (PIL/ImageMagick) and returns a text description
2. **GLM-5.2** (the "brain") receives the description + the original question and answers normally

This preserves GLM-5.2's reasoning, tool use, and response formatting while adding vision capability. Falls back to **swe-1-7** if kimi-k2-7 fails.

## Prerequisites

| Tool | Install | Required? |
|------|---------|-----------|
| [Node.js](https://nodejs.org/) 18+ | `brew install node` | ✅ Required |
| [9router](https://www.npmjs.com/package/9router) | `npm install -g 9router` | ✅ Required |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` | ✅ Required |
| [Devin CLI](https://devin.ai) | See [Devin docs](https://devin.ai) | ✅ Required |
| [ClaudeKit](https://github.com/unified-vista/claudekit-engineer) | Optional | ⬜ Optional |

> **Devin must be authenticated:** Run `devin auth login` before setup.

## Quick Start

```bash
# Clone
git clone https://github.com/mxuanvan02/devin-9router-bridge.git
cd devin-9router-bridge

# Start 9router (if not already running)
9router start

# Run setup — installs proxy, configures 9router + Claude Code
./scripts/setup.sh

# Restart Claude Code, then test
claude
```

In Claude Code, any prompt will now route through GLM-5.2 via Devin.

## Configuration

### Ports (configurable via environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `GLM_PROXY_PORT` | 20130 | glm-proxy listen port |
| `ROUTER_PORT` | 20128 | 9router port |
| `WINDSURF_PORT` | 8083 | windsurf-server port |
| `VISION_MODELS` | `kimi-k2-7,swe-1-7` | Vision models (comma-separated fallback) |
| `VISION_HOST` | `127.0.0.1` | windsurf-server host for vision |
| `VISION_PORT` | `8083` | windsurf-server port for vision |

```bash
GLM_PROXY_PORT=20131 ROUTER_PORT=20129 ./scripts/setup.sh
```

### Claude Code Settings

After setup, `~/.claude/settings.json` is updated:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:20130",
    "ANTHROPIC_API_KEY": "your-9router-api-key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ws/glm-5-2",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "ws/glm-5-2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "ws/glm-5-2"
  },
  "model": "ws/glm-5-2"
}
```

## Available Models

| Model ID | Backend | Context Window | Max Output | Vision | Promo Free? |
|----------|---------|----------------|------------|--------|-------------|
| `glm-5-2` | GLM-5.2 High (Cognition) | 128K | 200K | Via kimi/swe | ✅ Yes (tier 4) |
| `swe-1-7` | SWE-1.7 (Cognition) | 128K | 262K | ✅ Native (ACP+PIL) | ✅ Yes (tier 4) |
| `swe-1-7-lightning` | SWE-1.7 Lightning (Cognition) | 96K | 202K | ✅ Native (ACP+PIL) | ✅ Yes (tier 2) |
| `kimi-k2-7` | Kimi K2.7 (Moonshot) | 16K | 262K | ✅ Native (ACP+PIL) | ✅ Yes (tier 4) |

> **Note:** "Context Window" is the input token limit. "Max Output" is the maximum output tokens. These are distinct limits — total tokens (input + output) can exceed the context window. Values are from the live Devin API (`GetCliModelConfigs`), not the model's native specs.
>
> **Vision** = model can analyze images via ACP path (Devin CLI agent uses PIL/ImageMagick). GLM-5.2 itself can't see images — the proxy routes image requests to kimi-k2-7/swe-1-7 for description, then GLM-5.2 answers using the text description ("eyes + brain" pattern).
>
> 💡 **All 4 models are promo free** with Devin Pro (Windsurf) — they consume free credits, not paid quota. Paid variants like `glm-5-2-1m` (1M output), `glm-5-2-max` (max effort) require paid credits (tier 1). Default config uses `glm-5-2` for all Claude Code tiers (Opus/Sonnet/Haiku).

Add more models by editing `proxy/windsurf-server.js`.

## Project Structure

```
devin-9router-bridge/
├── proxy/
│   ├── glm-proxy.js              # Anthropic API ↔ GLM-5.2 bridge
│   ├── windsurf-server.js        # Devin → OpenAI-compatible API server
│   └── windsurf-provider.js      # Core: sends to server.codeium.com
├── proto/
│   └── windsurf.proto            # Protobuf schema (reverse-engineered)
├── scripts/
│   ├── setup.sh                  # One-command setup
│   ├── auto-start.sh             # macOS launchd auto-start
│   ├── auto-start-linux.sh       # Linux systemd auto-start
│   └── auto-start-windows.ps1    # Windows Task Scheduler auto-start
├── docs/
│   ├── GETTING_DEVIN_TOKEN.md    # How to get Devin session token
│   ├── TROUBLESHOOTING.md        # Common issues & fixes
│   ├── ARCHITECTURE.md           # How it works (detailed)
│   ├── HERMES_INTEGRATION.md     # Hermes Agent + GLM-5.2 setup
│   └── OPENCLAW_INTEGRATION.md   # OpenClaw + GLM-5.2 setup
├── package.json                  # npm dependencies (protobufjs)
├── LICENSE
└── README.md
```

## Debug

```bash
# Run proxy with debug logging
GLM_PROXY_DEBUG=1 node proxy/glm-proxy.js 20130 20128

# Full debug (logs system prompts + messages)
GLM_PROXY_DEBUG=2 node proxy/glm-proxy.js 20130 20128

# Check logs
tail -f /tmp/glm-proxy.log
tail -f /tmp/windsurf-server.log
```

## Context window configuration

GLM-5.2 is available as a **promo free model** with Devin Pro (Windsurf) — you get free credits that cover GLM-5.2 usage. The free variant (`glm-5-2`) has a **128K context window** (input) and **200K max output tokens**. The `glm-5-2-1m` variant supports **1M max output tokens** but requires **paid credits** (tier 1, costMultiplier 3x). Context window remains 128K on all variants. The proxy defaults to **no truncation** (full context passthrough).

If you hit content filter or quota limits on the promo tier, set truncation limits via env vars:

```bash
# Free tier: truncate system prompt to 1500 chars, messages to 3000 chars
GLM_PROXY_MAX_SYSTEM_LEN=1500 GLM_PROXY_MAX_MSG_LEN=3000 node proxy/glm-proxy.js

# Unlimited (default): no truncation
node proxy/glm-proxy.js
```

| Env var | Default | Description |
|---|---|---|
| `GLM_PROXY_MAX_SYSTEM_LEN` | `0` (no limit) | Max chars for system prompt (0 = no truncation) |
| `GLM_PROXY_MAX_MSG_LEN` | `0` (no limit) | Max chars per message (0 = no truncation) |
| `GLM_PROXY_DEBUG` | `0` | Debug logging level (1=basic, 2=verbose) |

## Auto-start (all platforms)

| OS | Script | Service type |
|---|---|---|
| **macOS** | `./scripts/auto-start.sh` | launchd plist |
| **Linux** | `./scripts/auto-start-linux.sh` | systemd user service |
| **Windows** | `powershell -ExecutionPolicy Bypass -File scripts/auto-start-windows.ps1` | Task Scheduler |

Each script installs the glm-proxy as a background service that starts at login and auto-restarts on failure.

## Using with Hermes Agent

Hermes Agent can use GLM-5.2 through glm-proxy for **tool calling** (which GLM-5.2 does not support natively in OpenAI format). See **[docs/HERMES_INTEGRATION.md](docs/HERMES_INTEGRATION.md)** for full setup guide.

Quick config — add to `~/.hermes/config.yaml` (or `%USERPROFILE%\.hermes\config.yaml` on Windows):

```yaml
model:
  default: ws/glm-5-2
  provider: nine-glm
  api_key: YOUR_9ROUTER_API_KEY
  base_url: http://localhost:20130    # glm-proxy, NOT 20128
  api_mode: anthropic_messages        # glm-proxy speaks Anthropic format
  context_length: 128000
  max_tokens: 200000
```

## Using with OpenClaw

OpenClaw can use GLM-5.2 through glm-proxy for **tool calling** (which GLM-5.2 does not support natively in OpenAI format). See **[docs/OPENCLAW_INTEGRATION.md](docs/OPENCLAW_INTEGRATION.md)** for full setup guide.

Quick config — add a `glm-proxy` provider to `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "glm-proxy": {
        "baseUrl": "http://localhost:20130",
        "api": "anthropic-messages",
        "apiKey": "YOUR_9ROUTER_API_KEY",
        "auth": "api-key",
        "models": [
          {
            "id": "ws/glm-5-2",
            "api": "anthropic-messages",
            "contextWindow": 128000,
            "maxTokens": 200000
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "glm-proxy/ws/glm-5-2"
      }
    }
  }
}
```

An automation script (`fix-openclaw-glm-proxy.py`) is included in the guide to migrate existing GLM models from `9router` to `glm-proxy` automatically.

## Limitations

- **Token expiry:** Devin CLI refreshes tokens in memory but doesn't write them back to `credentials.toml`. If you get "Cascade session" errors, run `devin auth login` again and restart windsurf-server.
- **Streaming-focused:** Non-streaming responses are not fully tested.
- **Content filter:** The Cognition API content filter is aggressive — some complex prompts may still be blocked.
- **Single tool per turn:** GLM-5.2 may not reliably handle multiple tool calls in one response.
- **Vision (OCR):** kimi-k2-7/swe-1-7 analyze images via PIL/ImageMagick (pixel-level). They handle colors, shapes, dimensions, and simple charts well, but **cannot OCR text** in images (PIL doesn't include Tesseract). For OCR, install `tesseract` and use the `ai-multimodal` skill.
- **Vision (complex scenes):** Complex images (detailed scenes, multi-object photos) may take 2-3 minutes per image due to ACP agent's pixel-by-pixel analysis. Simple images (solid colors, shapes) take ~10-15s.

## Uninstall

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.devin-9router-bridge.glm-proxy.plist 2>/dev/null
rm ~/Library/LaunchAgents/com.devin-9router-bridge.glm-proxy.plist

# Linux
systemctl --user stop devin-9router-bridge-glm-proxy 2>/dev/null
systemctl --user disable devin-9router-bridge-glm-proxy 2>/dev/null
rm ~/.config/systemd/user/devin-9router-bridge-glm-proxy.service

# Windows (PowerShell)
Unregister-ScheduledTask -TaskName "Devin9RouterBridge-glm-proxy" -Confirm:$false

# All platforms — kill processes and remove files
pkill -f "glm-proxy.js"
pkill -f "windsurf-server.js"
rm -rf ~/.devin-9router-bridge

# Restore Claude Code settings (backup was created during setup)
# Look for ~/.claude/settings.json.bak.* and restore the latest one
```

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026

## Acknowledgments

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic
- [9router](https://www.npmjs.com/package/9router) by 9Router
- [Devin](https://devin.ai) by Cognition
