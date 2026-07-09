# Devin-9Router-Bridge

**Connect Devin models (GLM-5.2, etc.) to Claude Code + ClaudeKit via 9router.**

If you have [9router](https://www.npmjs.com/package/9router), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), and a [Devin](https://devin.ai) account, this repo lets you use Devin's models (GLM-5.2 and others) as the backend for Claude Code and ClaudeKit — no Anthropic API key needed.

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

| Requirement | How to get it |
|-------------|---------------|
| **Node.js 18+** | `brew install node` |
| **9router** | `npm install -g 9router` |
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` |
| **Devin account** | Sign up at [devin.ai](https://devin.ai) |
| **Windsurf IDE** | Install from [codeium.com](https://codeium.com/windsurf) and login |

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/mxuanvan02/devin-9router-bridge.git
cd devin-9router-bridge

# 2. Run setup (installs proxy, configures 9router + Claude Code)
./scripts/setup.sh

# 3. Install ClaudeKit (optional, for slash commands like /ck-help)
./scripts/install-claudekit.sh

# 4. Set up auto-start (optional, starts proxy on boot)
./scripts/auto-start.sh

# 5. Restart Claude Code
#    Exit any running Claude Code session, then relaunch:
claude

# 6. Test it works
#    In Claude Code, type:
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
**Problem**: Cognition API's content filter blocks Claude Code's system prompt because it contains:
- Security instructions ("DoS attacks", "credential testing", "supply chain compromise")
- Billing headers (`x-anthropic-billing-header`)
- Imperative language ("MANDATORY. NON-NEGOTIABLE. NO EXCEPTIONS. MUST REMEMBER AT ALL TIMES!!!")

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
│   ├── install-claudekit.sh      # Install ClaudeKit
│   └── auto-start.sh             # macOS launchd auto-start
├── docs/
│   ├── GETTING_DEVIN_TOKEN.md    # How to get Devin session token
│   ├── TROUBLESHOOTING.md        # Common issues
│   └── ARCHITECTURE.md           # How it works (detailed)
├── README.md
└── LICENSE
```

## Configuration

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
  "model": "ws/glm-5-2",
  "fallbackModels": ["cx/gpt-5.5"]
}
```

## Available Models

Once configured, these models are available in Claude Code:

| Model alias | Backend |
|-------------|---------|
| `ws/glm-5-2` | GLM-5.2 via Devin/Cognition |
| `cx/gpt-5.5` | GPT-5.5 via Codex (fallback) |

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
- **Content filter**: The Cognition API content filter is aggressive — some complex prompts may still be blocked. The proxy sanitizes known triggers, but edge cases may exist.
- **Single tool per turn**: GLM-5.2 may not reliably handle multiple tool calls in one response.

## Uninstall

```bash
# Stop proxy
launchctl unload ~/Library/LaunchAgents/com.devin-9router-bridge.glm-proxy.plist 2>/dev/null
pkill -f "glm-proxy.js"

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
