# Contributing to Devin → 9Router Bridge

Thanks for your interest in contributing! 🎉

## Development Setup

```bash
git clone https://github.com/mxuanvan02/devin-9router-bridge.git
cd devin-9router-bridge
npm install
```

## Project Structure

- `proxy/` — Core proxy scripts (Node.js, no TypeScript)
- `proto/` — Protobuf schema for Cognition API
- `scripts/` — Setup and automation scripts
- `docs/` — Documentation

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/mxuanvan02/devin-9router-bridge/issues) first
2. Open a new issue with:
   - OS and Node.js version
   - Steps to reproduce
   - Expected vs actual behavior
   - Relevant log output (`/tmp/glm-proxy.log`, `/tmp/windsurf-server.log`)

### Submitting Pull Requests

1. Fork the repo and create a branch:
   ```bash
   git checkout -b fix/my-bugfix
   ```
2. Make your changes. Keep diffs minimal.
3. Test your changes:
   ```bash
   # Fresh clone test
   rm -rf /tmp/test-clone && cp -r . /tmp/test-clone && cd /tmp/test-clone
   rm -rf node_modules && npm install
   node -e "require('./proxy/windsurf-provider.js'); console.log('OK')"
   ```
4. Commit with clear messages:
   ```bash
   git commit -m "fix: handle empty messages array in glm-proxy"
   ```
5. Push and open a PR with a description of what changed and why.

### Code Style

- **Node.js, no TypeScript** — keep it simple, no build step
- **No external dependencies** except `protobufjs`
- **Comments in English** — explain *why*, not *what*
- **Keep files under 300 lines** — modularize if larger
- **No hardcoded paths** — use `os.homedir()`, `__dirname`, or env vars

### Adding Support for New Models

1. Add the model to `MODELS` array in `proxy/windsurf-server.js`
2. Test with:
   ```bash
   curl http://127.0.0.1:8083/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer devin" \
     -d '{"model":"new-model","messages":[{"role":"user","content":"Hi"}]}'
   ```
3. Update README's model table

## Areas Needing Help

- [ ] Linux systemd auto-start script
- [ ] Windows service wrapper
- [ ] Automated tests (vision routing, tool conversion, content filter)
- [ ] Support for non-streaming responses
- [ ] Token auto-refresh via Devin ACP protocol
- [ ] OCR support (integrate Tesseract for text-in-image extraction)
- [ ] Vision caching (cache image descriptions to avoid re-analyzing same image)
- [ ] Multi-image optimization (batch describe in parallel)

## Questions?

Open a [discussion](https://github.com/mxuanvan02/devin-9router-bridge/discussions) or issue.
