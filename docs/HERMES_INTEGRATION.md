# Hermes Integration — GLM-5.2 via glm-proxy

This guide configures [Hermes Agent](https://github.com/NousResearch/hermes-agent) to use **GLM-5.2** through the glm-proxy bridge, enabling proper **tool calling** (which GLM-5.2 does not support natively in OpenAI format).

## Why glm-proxy is required

| Without glm-proxy | With glm-proxy (port 20130) |
|---|---|
| Hermes → 9router (20128) OpenAI chat completions + `tools` param → GLM-5.2 returns **empty response** | Hermes → glm-proxy (20130) Anthropic messages + `tools` → proxy strips tools, injects `<tool_use>` text instructions → GLM returns text with `<tool_use>` blocks → proxy parses back to Anthropic `tool_use` content |

GLM-5.2 has **no native OpenAI tool-calling support**. The proxy bridges this by converting tools ↔ text instructions.

## Architecture

```
Hermes Agent (api_mode: anthropic_messages)
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
- Hermes Agent installed (`pip install hermes-agent` or from source)

## Configuration

### 1. Update `config.yaml`

Hermes config location per OS:

| OS | Path |
|---|---|
| **macOS / Linux** | `~/.hermes/config.yaml` |
| **Windows** | `%USERPROFILE%\.hermes\config.yaml` |

Replace the `model:` section and add `nine-glm` provider:

```yaml
model:
  default: ws/glm-5-2
  provider: nine-glm
  api_key: YOUR_9ROUTER_API_KEY
  base_url: http://localhost:20130
  api_mode: anthropic_messages
  context_length: 128000
  max_tokens: 200000

providers:
  # ... keep your existing providers ...

  nine-glm:
    base_url: http://localhost:20130
    api_key: YOUR_9ROUTER_API_KEY
    api_mode: anthropic_messages
    discover_models: false
    model: ws/glm-5-2
    models:
      ws/glm-5-2:
        context_length: 128000

  nine-glm-think:
    base_url: http://127.0.0.1:20130
    api_key: YOUR_9ROUTER_API_KEY
    api_mode: anthropic_messages
    discover_models: false
    model: ws/glm-5-2
    models:
      ws/glm-5-2:
        context_length: 128000

model_aliases:
  glm-5-2:
    model: ws/glm-5-2
    base_url: http://localhost:20130
  glm-think:
    model: ws/glm-5-2
    base_url: http://127.0.0.1:20130
```

### 2. Key fields explained

| Field | Value | Why |
|---|---|---|
| `provider` | `nine-glm` | Custom provider key — resolved to `custom` at runtime |
| `base_url` | `http://localhost:20130` | glm-proxy port (NOT 20128) |
| `api_mode` | `anthropic_messages` | glm-proxy speaks Anthropic `/v1/messages` format |
| `context_length` | `128000` | GLM-5.2 context window = 128K tokens (from live API) |

### 3. Two modes

| Alias | base_url | Use case |
|---|---|---|
| `glm-5-2` | `localhost:20130` | Default — tool calling tasks |
| `glm-think` | `127.0.0.1:20130` | Same proxy, different URL string so Hermes matches it separately for thinking mode |

Switch in Telegram/CLI: `/model glm-5-2` or `/model glm-think`

> **Note:** The `localhost` vs `127.0.0.1` trick lets Hermes distinguish two provider entries that point to the same physical endpoint. This is needed because Hermes matches `extra_body` by `base_url` string.

### 4. Restart Hermes gateway

```bash
hermes gateway restart
```

### 5. Test

Send a message via Telegram that requires tool calling, e.g.:
> "List files in /Users/yourname using the shell tool"

GLM-5.2 should call the `shell` tool via `<tool_use>` blocks → glm-proxy converts to proper tool_use → Hermes executes.

## Troubleshooting

### "Empty response (no content or reasoning)"

**Cause:** Hermes is hitting 9router (20128) directly with OpenAI format + tools. GLM-5.2 returns empty when it sees the `tools` param.

**Fix:** Verify `base_url` is `http://localhost:20130` (glm-proxy) and `api_mode` is `anthropic_messages`.

### `provider=nine-glm` in logs but no tool calls

**Cause:** Session override from `/model` is clobbering the resolved `provider: custom` with the alias's `provider: nine-glm`, which fails the `extra_body` match.

**Fix:** Remove `provider:` from model aliases — let runtime resolution set it to `custom`:

```yaml
model_aliases:
  glm-5-2:
    model: ws/glm-5-2
    base_url: http://localhost:20130
    # NO provider: field — let runtime resolve to "custom"
```

### Verify glm-proxy is running

```bash
# macOS / Linux
curl -s http://localhost:20130/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"ws/glm-5-2","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}' | head -5

# Windows (PowerShell)
Invoke-RestMethod -Uri "http://localhost:20130/v1/messages" `
  -Method Post `
  -Headers @{"x-api-key"="YOUR_KEY"; "anthropic-version"="2023-06-01"} `
  -ContentType "application/json" `
  -Body '{"model":"ws/glm-5-2","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

You should see `event: message_start` in the response.
