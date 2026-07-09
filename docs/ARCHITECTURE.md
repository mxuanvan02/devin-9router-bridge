# Architecture

## Overview

The bridge consists of three components that chain together to connect Claude Code to Devin's GLM-5.2:

```
┌─────────────┐     ┌──────────────┐     ┌──────────┐     ┌─────────────────┐     ┌──────────────┐
│ Claude Code │ ──▶ │  glm-proxy   │ ──▶ │ 9router  │ ──▶ │ windsurf-server │ ──▶ │ Devin/Cognition │
│ + ClaudeKit │     │  (port 20130)│     │(port 20128)│   │  (port 8083)    │     │ server.codeium.com │
└─────────────┘     └──────────────┘     └──────────┘     └─────────────────┘     └──────────────┘
                     Rewrites prompts     Your router      OpenAI-compatible       GLM-5.2 backend
                     Converts tools                        proxy for Devin
```

## Component Details

### 1. glm-proxy.js (Port 20130)

The main bridge. Receives Anthropic API format requests from Claude Code and transforms them for GLM-5.2.

**Request transformations:**
- Rewrites system prompt (removes "Claude Code" identity, security instructions, billing headers)
- Converts Anthropic tool definitions → text instructions
- GLM outputs `<tool_use name="...">{json}</tool_use>` XML tags instead of native tool_use
- Sanitizes messages (removes `<system-reminder>` tags, softens imperative language)
- Truncates system prompt to 1500 chars, messages to 3000 chars

**Response transformations:**
- Parses `<tool_use>` XML tags from GLM's text output
- Converts them to Anthropic `tool_use` content blocks
- Emits proper SSE events: `content_block_start`, `content_block_delta`, `content_block_stop`
- Sets `stop_reason: "tool_use"` when tool blocks are present

### 2. windsurf-server.js (Port 8083)

OpenAI-compatible API server that wraps the Devin/Cognition backend.

- Exposes `/v1/chat/completions` (streaming + non-streaming)
- Exposes `/v1/models` (lists available Devin models)
- Translates OpenAI format ↔ Devin's internal format
- Uses the Devin session token from `~/.codeium/windsurf/credentials.toml`

### 3. windsurf-provider.js

Core provider module that communicates with `server.codeium.com` (Devin's backend).

- Sends requests using Devin's proprietary protocol
- Handles authentication via session token
- Manages session IDs for conversation continuity
- Parses Devin's response format

## Why This Architecture?

### Why not connect Claude Code directly to Devin?

Claude Code expects the Anthropic Messages API format (`/v1/messages` with `tool_use` content blocks). Devin/Cognition uses a different protocol. The proxy bridges this gap.

### Why use 9router in the middle?

9router provides:
- Model routing (switch between providers)
- Rate limiting
- Load balancing
- API key management

If you already have 9router configured, the bridge integrates seamlessly.

### Why a separate windsurf-server?

The windsurf-server exposes Devin as an OpenAI-compatible API, which 9router can consume as a custom provider. This separation of concerns lets you:
- Use Devin models from any OpenAI-compatible client
- Route to other providers (OpenRouter, Ollama, etc.) via 9router
- Switch models without changing Claude Code config

## Data Flow Example

When you type `/ck-help` in Claude Code:

1. **Claude Code** sends a request to `http://localhost:20130/v1/messages` with:
   - System prompt: "You are Claude Code, Anthropic's official CLI..."
   - Tools: bash, str_replace_based_edit_tool, etc.
   - User message: "/ck-help"

2. **glm-proxy** transforms the request:
   - System prompt → "You are an interactive CLI-based coding assistant..." (1500 chars max)
   - Tools → text instructions: "Output <tool_use name="TOOL_NAME">{json}</tool_use>"
   - Forwards to 9router at `http://localhost:20128/v1/messages`

3. **9router** routes the request to the windsurf provider at `http://localhost:8083/v1/chat/completions`

4. **windsurf-server** converts the request to Devin's format and sends to `server.codeium.com`

5. **Devin/Cognition** processes the request with GLM-5.2 and returns a response

6. **windsurf-server** converts the response back to OpenAI format

7. **9router** passes the response back to glm-proxy

8. **glm-proxy** parses the response:
   - If GLM output `<tool_use name="bash">{"command":"ck-help"}</tool_use>`:
     - Converts to Anthropic `tool_use` content block
     - Sets `stop_reason: "tool_use"`
   - Streams the transformed response back to Claude Code

9. **Claude Code** receives the tool_use block and executes the bash command
