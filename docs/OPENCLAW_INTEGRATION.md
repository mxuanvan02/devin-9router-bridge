# OpenClaw Integration — GLM-5.2 via glm-proxy

This guide configures [OpenClaw](https://github.com/openclaw/openclaw) to use **GLM-5.2** through the glm-proxy bridge, enabling proper **tool calling**.

## Why glm-proxy is required

GLM-5.2 has **no native OpenAI tool-calling support**. When OpenClaw sends requests with the `tools` parameter to 9router (port 20128), GLM-5.2 returns empty responses or `[Error: internal error]`.

The glm-proxy bridge solves this by:
1. Receiving Anthropic `/v1/messages` format (with tools)
2. Converting tools → text instructions (`<tool_use>` XML blocks)
3. Forwarding to 9router **without tools**
4. Parsing `<tool_use>` blocks from GLM's text response → converting back to Anthropic `tool_use` content blocks

## Architecture

```
OpenClaw (api: anthropic-messages)
      ↓
glm-proxy (port 20130)         ← Strips tools, converts to <tool_use> text
      ↓
9router (port 20128)           ← Your existing router
      ↓
windsurf-server (port 8083)    ← Devin → OpenAI-compatible API
      ↓
server.codeium.com             ← GLM-5.2 backend
```

## Prerequisites

- glm-proxy running on port 20130 (run `./scripts/setup.sh` first)
- 9router running on port 20128
- OpenClaw installed and configured

## Configuration

### 1. Edit `openclaw.json`

Config location per OS:

| OS | Path |
|---|---|
| **macOS** | `~/AI/openclaw-stack/config/openclaw.json` (or `~/.openclaw-host/openclaw.json`) |
| **Linux** | `~/.openclaw-host/openclaw.json` |

### 2. Add `glm-proxy` provider

In the `models.providers` section, add a new provider:

```json
{
  "models": {
    "providers": {
      "9router": {
        "baseUrl": "http://localhost:20128/v1",
        "api": "openai-completions",
        "apiKey": "YOUR_9ROUTER_API_KEY",
        "auth": "api-key",
        "models": [
          // ... your non-GLM models stay here ...
        ]
      },
      "glm-proxy": {
        "baseUrl": "http://localhost:20130",
        "api": "anthropic-messages",
        "apiKey": "YOUR_9ROUTER_API_KEY",
        "auth": "api-key",
        "models": [
          {
            "id": "ws/glm-5-2",
            "name": "GLM-5.2 High (glm-proxy)",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 202752,
            "maxTokens": 131072,
            "api": "anthropic-messages",
            "compat": {
              "supportedReasoningEfforts": ["low", "medium", "high"],
              "reasoningEffortMap": {}
            }
          }
        ]
      }
    }
  }
}
```

### 3. Move GLM models from `9router` to `glm-proxy`

Remove any GLM-5.2 model entries from the `9router` provider's `models` array and add them to `glm-proxy` with `"api": "anthropic-messages"`.

### 4. Update agent model references

In `agents.defaults.model`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "glm-proxy/ws/glm-5-2",
        "fallbacks": [
          "9router/cx/gpt-5.5",
          "superkiro/claude-opus-4.8"
        ]
      }
    }
  }
}
```

Also update any per-model params keys in `agents.defaults.models`:
- `9router/ws/glm-5-2` → `glm-proxy/ws/glm-5-2`
- `9router/devin-glm-5-2` → `glm-proxy/devin-glm-5-2`

### 5. Key fields explained

| Field | Value | Why |
|---|---|---|
| `baseUrl` | `http://localhost:20130` | glm-proxy port (NOT 20128) |
| `api` | `anthropic-messages` | glm-proxy speaks Anthropic `/v1/messages` format |
| `auth` | `api-key` | Same 9router API key |
| `contextWindow` | `202752` | GLM-5.2 free tier = ~200K tokens |

### 6. Validate and restart

```bash
# Validate config
openclaw config validate

# Restart gateway
# macOS (launchd):
launchctl bootout gui/$(id -u)/com.van.openclaw-native 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.van.openclaw-native.plist

# Linux (systemd):
systemctl --user restart openclaw-gateway.service
```

### 7. Verify

Check logs for `agent model: glm-proxy/ws/glm-5-2`:

```bash
# macOS
tail -f ~/AI/openclaw-stack/config/logs/native.out.log | grep "agent model"

# Linux
journalctl --user -u openclaw-gateway.service -f | grep "agent model"
```

## Troubleshooting

### "Unrecognized key: apiKeyRef"

OpenClaw's config validator rejects `apiKeyRef` on custom providers. Use `apiKey` directly instead:

```json
"glm-proxy": {
  "baseUrl": "http://localhost:20130",
  "api": "anthropic-messages",
  "apiKey": "YOUR_KEY",
  "auth": "api-key",
  "models": [...]
}
```

### GLM-5.2 returns `[Error: internal error]`

This happens when GLM-5.2 receives tools in OpenAI format (via 9router directly). Make sure the model is under the `glm-proxy` provider with `api: anthropic-messages`, NOT under `9router` with `api: openai-completions`.

### Model not found after switching

If OpenClaw can't find `glm-proxy/ws/glm-5-2`, verify:
1. The `glm-proxy` provider exists in `models.providers`
2. The model `ws/glm-5-2` is in its `models` array
3. The model's `api` field is `anthropic-messages`

### Verify glm-proxy is running

```bash
curl -s http://localhost:20130/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"ws/glm-5-2","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}' | head -5
```

You should see `event: message_start` in the response.

## Automation script

To apply this fix automatically, use this Python script:

```python
#!/usr/bin/env python3
"""Add glm-proxy provider to OpenClaw config and move GLM-5.2 models."""
import json, copy, shutil, sys
from datetime import datetime

config_path = sys.argv[1] if len(sys.argv) > 1 else "openclaw.json"
backup = config_path + ".bak-glm-proxy-" + datetime.now().strftime("%Y%m%d-%H%M%S")
shutil.copy2(config_path, backup)
print(f"Backup: {backup}")

with open(config_path) as f:
    cfg = json.load(f)

providers = cfg["models"]["providers"]

# Find the 9router provider (could be named "9router" or "nine-router")
router_key = None
for k in providers:
    if "9router" in k or "nine-router" in k:
        router_key = k
        break
if not router_key:
    print("ERROR: No 9router/nine-router provider found")
    sys.exit(1)

router = providers[router_key]

# Find GLM models
glm_models = [m for m in router["models"]
               if "glm-5" in m.get("id", "").lower() or "glm5" in m.get("id", "").lower()]
print(f"Found {len(glm_models)} GLM models in {router_key}")

# Create glm-proxy provider
glm_proxy_models = []
for m in glm_models:
    nm = copy.deepcopy(m)
    nm["api"] = "anthropic-messages"
    glm_proxy_models.append(nm)

# Remove GLM from router
router["models"] = [m for m in router["models"] if m not in glm_models]

providers["glm-proxy"] = {
    "baseUrl": "http://localhost:20130",
    "api": "anthropic-messages",
    "auth": "api-key",
    "apiKey": router.get("apiKey"),
    "models": glm_proxy_models
}

# Update agent model references
agent = cfg["agents"]["defaults"]
primary = agent["model"].get("primary", "")
if "glm-5-2" in primary and router_key in primary:
    agent["model"]["primary"] = primary.replace(router_key, "glm-proxy")
    print(f"Updated primary: {primary} -> {agent['model']['primary']}")

fallbacks = agent["model"].get("fallbacks", [])
agent["model"]["fallbacks"] = [
    f.replace(router_key + "/ws/glm-5-2", "glm-proxy/ws/glm-5-2").replace(
        router_key + "/devin-glm-5-2", "glm-proxy/devin-glm-5-2")
    for f in fallbacks
]

# Update per-model params keys
models_cfg = agent.get("models", {})
for old_k in list(models_cfg.keys()):
    new_k = old_k
    if old_k == f"{router_key}/ws/glm-5-2":
        new_k = "glm-proxy/ws/glm-5-2"
    elif old_k == f"{router_key}/devin-glm-5-2":
        new_k = "glm-proxy/devin-glm-5-2"
    if new_k != old_k:
        models_cfg[new_k] = models_cfg.pop(old_k)
        print(f"Renamed: {old_k} -> {new_k}")

with open(config_path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print(f"\nDone! {len(glm_proxy_models)} GLM models moved to glm-proxy provider.")
print("Restart OpenClaw gateway to apply changes.")
```

Save as `fix-openclaw-glm-proxy.py` and run:

```bash
python3 fix-openclaw-glm-proxy.py /path/to/openclaw.json
```
