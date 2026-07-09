# Devin-9Router-Bridge

**Connect Devin models (GLM-5.2, etc.) to Claude Code + ClaudeKit via 9router.**

If you already have [9router](https://www.npmjs.com/package/9router), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [ClaudeKit](https://github.com/unified-vista/claudekit-engineer), and a [Devin](https://devin.ai) account, this repo lets you use Devin's models (GLM-5.2 and others) as the backend — no Anthropic API key needed.

## Architecture

```
Claude Code / ClaudeKit (Anthropic API format)
        ↓
glm-proxy (port 20130)              ← Rewrites prompts, converts tools
        ↓
9router (port 20128)               ← Your existing router
        ↓
windsurf-server (port 8083)        ← Devin → OpenAI-compatible API
        ↓
server.codeium.com                 ← Devin/Cognition backend (GLM-5.2)
```

## Prerequisites

You must have these installed and working BEFORE running setup:

| Requirement | Install | Verify |
|-------------|---------|--------|
| **Node.js 18+** | `brew install node` | `node --version` |
| **9router** | `npm install -g 9router` | `9router --version` |
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| **ClaudeKit** | Follow [ClaudeKit docs](https://github.com/unified-vista/claudekit-engineer) | `ck --version` |
| **Devin CLI** | Follow [Devin docs](https://devin.ai) | `devin auth status` |

Devin must be authenticated (`devin auth status` shows "Logged in").

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/mxuanvan02/devin-9router-bridge.git
cd devin-9router-bridge

# 2. Make sure 9router is running
9router start

# 3. Run setup (installs proxy, configures 9router + Claude Code)
./scripts/setup.sh

# 4. (Optional) Set up auto-start on boot
./scripts/auto-start.sh

# 5. Restart Claude Code (exit any running session, then relaunch)
claude

# 6. Test it works — in Claude Code, type:
/ck-help
```

## What This Bridge Fixes

GLM-5.2 (via Devin/Cognition) is incompatible with Claude Code out of the box. This proxy fixes three issues:

### 1. Identity Conflict
**Problem**: GLM-5.2 outputs `[Error: internal error occurred]` when it sees "You are Claude Code, Anthropic's official CLI" in the system prompt.

**Fix**: The proxy rewrites the system prompt to "You are an interactive CLI-based coding assistant".

### 2. No Native Tool Use
**Problem**: GLM-5.2 doesn't support Anthropic's `tool_use` format — it returns empty content when tools are provided.

**Fix**: The proxy converts tool definitions to text instructions. GLM outputs `<tool_use name="bash">{"command":"ls"}</tool_use>` XML tags, which the proxy parses back into Anthropic `tool_use` content blocks.

### 3. Content Policy Blocks
**Problem**: Cognition API's content filter blocks Claude Code's system prompt because it contains security instructions, billing headers, and imperative language.

**Fix**: The proxy sanitizes all of these before forwarding to the Cognition API.

## Files

```
devin-9router-bridge/
├── proxy/
│   ├── glm-proxy.js              # Main bridge: Claude API ↔ GLM-5.2
│   ├── windsurf-server.js        # Devin → OpenAI-compatible API server
│   └── windsurf-provider.js      # Core: sends to server.codeium.com
├── scripts/
│   ├── setup.sh                  # One-command setup
│   └── auto-start.sh             # macOS launchd auto-start
├── docs/
│   ├── GETTING_DEVIN_TOKEN.md    # How to get Devin session token
│   ├── TROUBLESHOOTING.md        # Common issues
│   └── ARCHITECTURE.md           # How it works (detailed)
├── README.md
└── LICENSE
```

## Configuration

### Ports (configurable via environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `GLM_PROXY_PORT` | 20130 | glm-proxy listen port |
| `ROUTER_PORT` | 20128 | 9router port |
| `WINDSURF_PORT` | 8083 | windsurf-server port |

Override before running setup:
```bash
GLM_PROXY_PORT=20131 ROUTER_PORT=20129 ./scripts/setup.sh
```

### Claude Code Settings

After setup, your `~/.claude/settings.json` will have:

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

Once configured, these models are available in Claude Code:

| Model alias | Backend |
|-------------|---------|
| `ws/glm-5-2` | GLM-5.2 via Devin/Cognition |

You can add more Devin models by editing `proxy/windsurf-server.js`.

## Debug

```bash
# Run proxy with debug logging
GLM_PROXY_DEBUG=1 node ~/.devin-9router-bridge/glm-proxy.js 20130 20128

# Full debug (logs system prompts + messages)
GLM_PROXY_DEBUG=2 node ~/.devin-9router-bridge/glm-proxy.js 20130 20128

# Check logs
tail -f /tmp/glm-proxy.log
tail -f /tmp/windsurf-server.log
```

## Limitations

- **Streaming-focused**: Non-streaming responses are not fully tested
- **macOS auto-start**: Uses launchd. For Linux, use systemd. For Windows, use a service wrapper.
- **Content filter**: The Cognition API content filter is aggressive — some complex prompts may still be blocked.
- **Single tool per turn**: GLM-5.2 may not reliably handle multiple tool calls in one response.

## Uninstall

```bash
# Stop proxy
launchctl unload ~/Library/LaunchAgents/com.devin-9router-bridge.glm-proxy.plist 2>/dev/null
pkill -f "glm-proxy.js"
pkill -f "windsurf-server.js"

# Remove installed files
rm -rf ~/.devin-9router-bridge

# Restore Claude Code settings (backup was created during setup)
# Look for ~/.claude/settings.json.bak.* and restore the latest one
```

## License

MIT

## Credits

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic
- [9router](https://www.npmjs.com/package/9router) by 9Router
- [Devin](https://devin.ai) by Cognition
- [ClaudeKit](https://github.com/unified-vista/claudekit-engineer) by Unified Vista
