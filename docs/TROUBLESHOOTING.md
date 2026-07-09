# Troubleshooting

## Common Issues

### `[Error: There was an error with your Cascade session, please update your editor]`

**Cause**: Devin session token has expired or is invalid.

**Fix**:
```bash
# Re-authenticate with Devin
devin auth logout
devin auth login

# Restart windsurf-server to reload token
pkill -f windsurf-server
node ~/.devin-9router-bridge/windsurf-server.js 8083 &

# Verify it works
curl http://127.0.0.1:8083/v1/models
```

---

### `[Error: internal error occurred (trace ID: ...)]`

**Cause**: GLM-5.2 received "You are Claude Code" in the system prompt.

**Fix**: The proxy should rewrite this automatically. If you still see it:
- Make sure the proxy is running: `curl http://127.0.0.1:20130/health`
- Restart the proxy: `pkill -f glm-proxy.js && node ~/.devin-9router-bridge/glm-proxy.js 20130 20128`
- Check the proxy is in the Claude Code settings: `ANTHROPIC_BASE_URL` should be `http://localhost:20130`

---

### `[Error: Your request was blocked by our content policy]`

**Cause**: Cognition API content filter blocked the request.

**Fix**: The proxy sanitizes known triggers, but some edge cases may exist:
- Run with debug to see what's being sent: `GLM_PROXY_DEBUG=2 node ~/.devin-9router-bridge/glm-proxy.js 20130 20128`
- Check `/tmp/glm-proxy.log` for `RESPONSE ISSUE` lines
- If a specific phrase triggers it, add it to the sanitization regex in `glm-proxy.js`

---

### `The model's tool call could not be parsed`

**Cause**: GLM-5.2 output a tool_use block that the proxy couldn't parse.

**Fix**: 
- Check if GLM output the `<tool_use>` tags correctly in the debug log
- The tool name might be wrong — GLM sometimes outputs tool names differently
- Try simplifying your request

---

### Claude Code connects to external servers (not localhost)

**Cause**: Claude Code is not using the proxy. Check:
1. `~/.claude/settings.json` has `ANTHROPIC_BASE_URL` = `http://localhost:20130`
2. No shell alias overrides: `alias claude` (if there's an alias, it might override settings)
3. Restart Claude Code after changing settings

**Fix**:
```bash
# Check for shell alias
grep "alias claude" ~/.zshrc ~/.bashrc

# If there's an alias, either remove it or add the env var:
alias claude='ANTHROPIC_BASE_URL=http://localhost:20130 claude --settings {"ultracode":true,"fastMode":true}'
```

---

### windsurf-server won't start

**Check**:
```bash
# Is port 8083 already in use?
lsof -iTCP:8083

# Check the log
cat /tmp/windsurf-server.log

# Verify credentials
cat ~/.codeium/windsurf/credentials.toml
```

---

### 9router not running

```bash
# Start 9router
9router start

# Check it's running
curl http://127.0.0.1:20128/health
```

---

### Proxy crashes or hangs

```bash
# Kill all proxy processes
pkill -f "glm-proxy.js"
pkill -f "windsurf-server.js"

# Restart both
node ~/.devin-9router-bridge/windsurf-server.js 8083 &
sleep 2
node ~/.devin-9router-bridge/glm-proxy.js 20130 20128 &

# Check health
curl http://127.0.0.1:8083/health
curl http://127.0.0.1:20130/health
```

---

### GLM-5.2 returns empty response

**Cause**: GLM-5.2 sometimes returns empty content for complex requests.

**Fix**:
- Try simplifying your prompt
- Check if the model is available: `curl http://127.0.0.1:8083/v1/models`
- The monthly limit might be reached (check Devin account)
- Use the fallback model: set `"model": "cx/gpt-5.5"` in settings.json

---

## Debug Mode

```bash
# Level 1: Log request sizes and issues
GLM_PROXY_DEBUG=1 node ~/.devin-9router-bridge/glm-proxy.js 20130 20128

# Level 2: Log full system prompts and message content
GLM_PROXY_DEBUG=2 node ~/.devin-9router-bridge/glm-proxy.js 20130 20128

# Check logs
tail -f /tmp/glm-proxy.log
tail -f /tmp/glm-proxy.error.log
tail -f /tmp/windsurf-server.log
```

## Getting Help

1. Check the logs first (`/tmp/glm-proxy.log`)
2. Search for your error in this file
3. Open an issue on GitHub with:
   - The error message
   - The debug log (redact any secrets)
   - Your setup (OS, Node version, 9router version)
